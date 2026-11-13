"""
Speaker separation — who spoke when, and which words are theirs.

A caption that puts two people on one line is wrong even when every word in it
is right: the reader cannot tell where one voice stops and the next begins.
This module answers "whose word is this", so the segmenter can force a caption
break at every speaker change and label the result.

Two backends, best first:

Sortformer (Apple Silicon) is an end-to-end diariser — the speaker encoder
from Nemotron 3.5 Transcribe, published on its own. It reports, every 10 ms,
which of up to eight people is talking, overlaps included, and each word goes
to whoever is most active across it. Short interjections are its strength: a
one-second "Your pieces?" is a second of activity, where an embedding needs
several seconds of a voice before it can call it a person.

ECAPA (everywhere else, and the fallback) is embedding clustering:

  1. Words — already timed by the recogniser or the forced aligner — are
     grouped into short spans, split at pauses and at the ends of sentences.
     Working from the word times rather than a fixed window grid means every
     span edge is a real boundary between words, which is where a voice change
     actually happens; a grid buries changes in the middle of a window and
     blurs the boundary.
  2. Each span is encoded to a speaker embedding (ECAPA-TDNN), a vector that
     describes the voice rather than the words.
  3. Those embeddings are clustered by splitting, one group in two at a time.
     With the speaker count known, the split that tightens its group most is
     taken until there are that many; otherwise a split is taken only while
     both halves come out more alike than the group they came from.
  4. Labels are smoothed, changes that fall where no speaker could have changed
     are dropped, and what is left is merged into turns.

pyannote's pipelines are the usual answer here and are deliberately not used:
their weights sit behind a licence acceptance and an access token, which does
not fit an app whose every other model installs on a button click. The ECAPA
path's trade is overlapping speech — when two people talk at once, one of them
wins the span.

Neither backend can label a word the recogniser never wrote down. Speech under
someone else's — an interviewer's question over the end of an answer — is often
dropped by the transcription model itself, and so has no caption to label.

Nothing here ever raises: a missing speaker label must not cost the operator an
otherwise good transcript.
"""

import os
import wave

import model_registry as registry

# A span shorter than this holds too little voice for a stable embedding, and
# one longer risks covering a speaker change.
MIN_SPAN_SEC = 1.0
MAX_SPAN_SEC = 3.0

# A gap at least this long always ends a span. Cheap insurance: a change of
# speaker nearly always happens across a pause, so cutting here keeps the two
# voices out of the same embedding.
SPLIT_PAUSE_SEC = 0.4

# The end of a sentence also ends a span, however little silence follows it.
# Dialogue is handed over on a full stop far more often than mid-clause, and it
# is regularly handed over with no measurable pause at all — "...wrong room."
# "In here," is two people inside a fifth of a second. Without this cut the two
# of them share one embedding, one label, and one caption.
SENTENCE_END_CHARS = '.!?…。！？'
CLOSING_CHARS = '"\'”’)]}»'

# Neither side of a sentence cut is worth making if it is shorter than this:
# below a third of a second there is not enough voice to place at all, and a
# wrong label is worse than a missing boundary.
LEXICAL_MIN_SEC = 0.3

# Audio pulled in either side of a span, so a short one still gives the encoder
# something to work with. Never more than half the silence next to it, since
# past the halfway mark the nearest voice is the neighbour's, not this one's —
# and after a sentence cut there is often no silence to take.
CONTEXT_SEC = 0.15

# There is no fixed distance at which two spans become two people. How far
# apart one voice's own spans sit depends on the recording far more than on the
# voice: a presenter outdoors over a music bed spreads to a median of 0.72
# against himself, which is further than two women on one phone line sit from
# each other. Any single threshold either invents people in the first or merges
# them in the second — so a split is judged against the group it came from
# instead (see _cluster).
#
# Auto mode will not split off a voice with fewer strong spans than this. Below
# it the group's own spread rests on one or two pairs, which is not enough to
# tell a person from a handful of noisy spans.
MIN_VOICE_SPANS = 3

# Neither half of a split may be smaller than this share of the strong spans,
# with or without a known count. The spans that end up alone are the oddities —
# a line over a music sting, a laugh, one word stretched over a pause — and
# given a speaker slot they take it from a real person.
MIN_GROUP_SHARE = 0.05

# Auto mode never invents more than this many people. Material with more voices
# than this is a panel show, not a promo, and the count is worth setting by hand.
MAX_SPEAKERS = 8

# A span this short, mid-flow and with agreeing neighbours, is a clustering
# wobble. See _smooth for why the pauses around it are what settles that.
SMOOTH_MAX_SEC = 0.6

BATCH_SPANS = 16

# Ceiling on the spans clustered at once, which is what sets the peak memory of
# the distance matrix. Around two hours of continuous dialogue.
MAX_CLUSTER_SPANS = 3000


def _runtime_available(entry):
    """Whether a backend's runtime is importable on this machine."""
    try:
        import numpy  # noqa: F401
        if entry['id'] == registry.SORTFORMER_MODEL['id']:
            from mlx_audio.vad import load  # noqa: F401
        else:
            import torch  # noqa: F401
            import speechbrain  # noqa: F401
        return True
    except Exception:
        return False


def _describe_entry(entry):
    out = registry.describe_extra(entry)
    out['available'] = _runtime_available(entry)
    return out


def ready_backend():
    """The best speaker model whose runtime and weights are both present, or None."""
    for entry in registry.DIARIZER_MODELS:
        if registry.entry_installed(entry) and _runtime_available(entry):
            return entry
    return None


def describe():
    """
    The preferred speaker model plus live state, for Settings and the
    transcribe dialog.

    The top level is the model this machine should use, so the dialog can say
    exactly what to install. `ready` is whether *any* backend can run — an
    older setup with only the ECAPA model keeps working until Sortformer is
    added — and `models` lists every backend for the Settings rows.
    """
    models = [_describe_entry(m) for m in registry.DIARIZER_MODELS]
    ready = ready_backend()
    return dict(models[0], ready=ready is not None,
                backend=ready['id'] if ready else None, models=models)


def diarize_words(wav_path, words, speakers='auto', progress_cb=None):
    """
    Label every word with the person who said it.

    The word dicts are labelled in place, so a caller holding the same list
    sees the speakers without reading the return value.

    Sortformer is used where it is ready, ECAPA otherwise; if Sortformer fails
    on a recording, ECAPA gets a go before the job settles for no labels.

    @param words    [{word, start, end}, ...] in time order
    @param speakers 'auto', or a known speaker count
    @returns {'words': [...], 'turns': [...], 'count': int} — words carry a
             'speaker' key — or None when separation could not run at all.
    """
    for entry in registry.DIARIZER_MODELS:
        if not (registry.entry_installed(entry) and _runtime_available(entry)):
            continue
        try:
            if entry['id'] == registry.SORTFORMER_MODEL['id']:
                result = _diarize_sortformer(wav_path, words, speakers, progress_cb)
            else:
                result = _diarize(wav_path, words, speakers, progress_cb)
        except Exception:
            result = None
        if result:
            return result
    return None


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

def _diarize(wav_path, words, speakers, progress_cb):
    import numpy as np

    words = [w for w in (words or []) if w.get('start') is not None]
    if not words:
        return None

    wanted = _speaker_count(speakers)
    spans = _spans(words)
    if not spans:
        return None

    # One span, or a fixed count of one, needs no model at all.
    if wanted == 1 or len(spans) < 2:
        return _single_speaker(words)

    samples, rate = _read_wav(wav_path)
    if samples is None or not len(samples):
        return None

    if progress_cb:
        progress_cb(0.05, 'Loading the speaker model…')
    encoder, device = _load_encoder()

    embeddings = _embed(encoder, device, samples, rate, spans, progress_cb)
    if embeddings is None:
        return None

    # Short spans are clustered *against* the result rather than being allowed
    # to shape it: a 0.4s embedding is noisy enough to open a cluster of its
    # own, which would show up as a speaker who says two words in an hour.
    strong = [i for i, s in enumerate(spans) if (s['end'] - s['start']) >= MIN_SPAN_SEC]
    if len(strong) < 2:
        strong = list(range(len(spans)))

    # Clustering holds a full distance matrix, so a feature-length interview
    # would ask for gigabytes. Past the cap the voices are found from an evenly
    # spread sample instead — every span is still labelled afterwards, against
    # the clusters that sample produced.
    if len(strong) > MAX_CLUSTER_SPANS:
        step = len(strong) / float(MAX_CLUSTER_SPANS)
        strong = [strong[int(i * step)] for i in range(MAX_CLUSTER_SPANS)]

    if progress_cb:
        progress_cb(0.88, 'Grouping voices…')
    labels = _cluster(embeddings[strong], k=wanted)
    if labels is None:
        return None
    if labels.max() == 0 and wanted is None:
        return _single_speaker(words)

    centroids = _centroids(embeddings[strong], labels)
    assigned = _nearest(embeddings, centroids)
    _smooth(spans, assigned)
    _settle(words, spans, assigned)

    order = _rename_in_first_appearance_order(spans, assigned)
    for span, label in zip(spans, assigned):
        span['speaker'] = order[int(label)]

    for span in spans:
        for i in span['words']:
            words[i]['speaker'] = span['speaker']

    turns = _turns(spans)
    return {'words': words, 'turns': turns,
            'count': len(set(t['speaker'] for t in turns))}


# ---------------------------------------------------------------------------
# Sortformer: frame-level speaker activity
# ---------------------------------------------------------------------------

# Below this mean activity across a word, nobody is clearly speaking it — a
# word the aligner placed in a breath, or speech too quiet to attribute — and
# it takes the label of the words around it instead.
ACTIVITY_FLOOR = 0.1

# How far a handover may be moved forward to the end of the sentence it falls
# in, and how much of the earlier speaker must still be audible over the words
# moved. See _snap_handovers.
SNAP_WORDS = 2
SNAP_MIN_ACTIVITY = 0.2

_sortformer = None


def _load_sortformer(progress_cb=None):
    """Loaded once and kept: the weights are 200 MB and take seconds to build."""
    global _sortformer
    if _sortformer is None:
        if progress_cb:
            progress_cb(0.05, 'Loading the speaker model…')
        from mlx_audio.vad import load
        _sortformer = load(registry.SORTFORMER_MODEL['repo'], strict=True)
    return _sortformer


def _diarize_sortformer(wav_path, words, speakers, progress_cb):
    """
    Speakers from Sortformer's activity: who is talking in each 10 ms frame.

    Each word goes to whoever is most active across it. Unlike the embedding
    path there is no grouping step to get wrong — the model has already kept
    track of who is who across the recording — and nothing needs a minimum
    length, so a single "Okay?" from the other side of the table is caught.
    """
    import numpy as np
    import mlx.core as mx

    words = [w for w in (words or []) if w.get('start') is not None]
    if not words:
        return None

    wanted = _speaker_count(speakers)
    if wanted == 1:
        return _single_speaker(words)

    samples, rate = _read_wav(wav_path)
    if samples is None or not len(samples):
        return None
    duration = len(samples) / float(rate)

    model = _load_sortformer(progress_cb)

    # Streamed rather than run whole: the model works through a long recording
    # with bounded memory either way, and the chunks give the progress bar
    # something to report.
    hop = getattr(getattr(model, '_processor_config', None), 'hop_length', None)
    chunks = []
    for result in model.generate_stream(samples, rate):
        chunks.append(np.array(result.speaker_probs.astype(mx.float32)))
        state = getattr(result, 'state', None)
        if progress_cb and hop and state is not None:
            done = state.frames_processed * hop / float(rate)
            progress_cb(0.1 + 0.8 * min(1.0, done / duration),
                        f'Separating speakers… {int(done)}s of {int(duration)}s')
    try:
        mx.clear_cache()
    except Exception:
        pass

    activity = np.concatenate([c for c in chunks if len(c)]) if chunks else None
    if activity is None or not len(activity):
        return None
    step = duration / len(activity)

    if wanted:
        # Told how many people there are: keep the busiest that many and let
        # each word choose among them. A sixth "speaker" Sortformer heard for a
        # second is more likely an echo of one of the five than a person.
        keep = np.argsort(-activity.sum(axis=0))[:wanted]
        mask = np.zeros(activity.shape[1])
        mask[keep] = 1.0
        activity = activity * mask

    per_word = _word_activity(words, activity, step)
    labels = _label_words(per_word)
    _snap_handovers(words, labels, per_word)

    order = {}
    for label in labels:
        if label not in order:
            order[label] = f'Speaker {len(order) + 1}'
    for w, label in zip(words, labels):
        w['speaker'] = order[label]

    turns = _turns([{'start': float(w['start']),
                     'end': float(w.get('end') or w['start']),
                     'speaker': w['speaker']} for w in words])
    return {'words': words, 'turns': turns, 'count': len(order)}


def _word_activity(words, activity, step):
    """Mean activity of every speaker across each word's frames."""
    import numpy as np
    out = []
    last = len(activity)
    for w in words:
        start = float(w['start'])
        end = max(start, float(w.get('end') or start))
        a = min(last - 1, max(0, int(start / step)))
        b = min(last, max(a + 1, int(np.ceil(end / step))))
        out.append(activity[a:b].mean(axis=0))
    return out


def _label_words(per_word):
    """
    The most active speaker for each word; words nobody is clearly speaking
    carry on with the speaker before them (or, at the very start, after them).
    """
    labels = [int(a.argmax()) if a.max() >= ACTIVITY_FLOOR else None for a in per_word]
    known = [label for label in labels if label is not None]
    if not known:
        return [0] * len(labels)
    current = known[0]
    for i, label in enumerate(labels):
        if label is None:
            labels[i] = current
        else:
            current = label
    return labels


def _snap_handovers(words, labels, per_word):
    """
    Move a handover that lands a word or two before a sentence end to that end.

    Where two people overlap at a handover, the words at the seam are a toss-up
    on activity alone — "...I'm in New Jersey now, | though. Well, there isn't"
    gives "though." to the person who answers, and the caption that follows
    then opens with someone else's word. The sentence boundary is the better
    witness, so the change moves there — but only while the first speaker is
    still audible across the words moved. A real interruption mid-sentence
    ("I was going to—" / "Wait.") has the first speaker silent under "Wait.",
    and stays where it is.
    """
    for i in range(1, len(labels)):
        before = labels[i - 1]
        if labels[i] == before or _ends_sentence(words[i - 1]):
            continue
        for j in range(i, min(i + SNAP_WORDS, len(labels))):
            if labels[j] != labels[i]:
                break
            if _ends_sentence(words[j]):
                run = range(i, j + 1)
                if all(per_word[k][before] >= SNAP_MIN_ACTIVITY for k in run):
                    for k in run:
                        labels[k] = before
                break
    return labels


# ---------------------------------------------------------------------------
# ECAPA: voice embeddings, grouped
# ---------------------------------------------------------------------------

def _speaker_count(speakers):
    """'auto' (or anything unparseable) means decide from the audio."""
    if speakers in (None, '', 'auto'):
        return None
    try:
        count = int(speakers)
    except (TypeError, ValueError):
        return None
    return max(1, min(MAX_SPEAKERS, count)) if count > 0 else None


def _single_speaker(words):
    for w in words:
        w['speaker'] = 'Speaker 1'
    return {'words': words,
            'turns': [{'start': float(words[0]['start']),
                       'end': float(words[-1].get('end', words[-1]['start'])),
                       'speaker': 'Speaker 1'}],
            'count': 1}


def _spans(words):
    """
    Group words into spans that plausibly hold a single voice.

    A long pause ends a span even when the span is short — correctness at the
    boundary matters more than embedding quality, and short spans are handled
    later by assigning them to an existing cluster rather than seeding one.

    Every span is then cut again wherever a sentence ends inside it, for the
    same reason: a boundary the audio does not announce is still a boundary.
    """
    spans = []
    current = None

    for i, w in enumerate(words):
        start = float(w.get('start') or 0.0)
        end = float(w.get('end') or start)
        if end < start:
            end = start

        if current is None:
            current = {'start': start, 'end': end, 'words': [i]}
            continue

        gap = start - current['end']
        if gap >= SPLIT_PAUSE_SEC or (end - current['start']) > MAX_SPAN_SEC:
            spans.append(current)
            current = {'start': start, 'end': end, 'words': [i]}
        else:
            current['end'] = max(current['end'], end)
            current['words'].append(i)

    if current:
        spans.append(current)

    out = []
    for span in spans:
        out.extend(_split_at_sentences(span, words))
    return out


def _ends_sentence(word):
    """Whether a word closes a sentence, ignoring any quote or bracket after it."""
    text = str(word.get('word') or word.get('text') or '').strip()
    while text and text[-1] in CLOSING_CHARS:
        text = text[:-1]
    return bool(text) and text[-1] in SENTENCE_END_CHARS


def _bounds(words, indexes):
    """Start and end of a run of words, tolerant of times that step backwards."""
    start = float(words[indexes[0]].get('start') or 0.0)
    end = start
    for i in indexes:
        w = words[i]
        end = max(end, float(w.get('end') or w.get('start') or start))
    return start, end


def _split_at_sentences(span, words):
    """
    Cut one span wherever a sentence ends part-way through it.

    Costless when the speaker does not in fact change: both pieces land in the
    same cluster and _turns joins them straight back up. When the speaker does
    change, this is the only place the change can still be seen — the pause that
    would otherwise have marked it is not there.

    A cut that would leave either side too short to embed is not made: the piece
    stays where it is, mislabelled at worst as it was before.
    """
    indexes = span['words']
    if len(indexes) < 2:
        return [span]

    pieces = []
    head = 0

    for k in range(len(indexes) - 1):
        if not _ends_sentence(words[indexes[k]]):
            continue
        head_start, head_end = _bounds(words, indexes[head:k + 1])
        tail_start, tail_end = _bounds(words, indexes[k + 1:])
        if (head_end - head_start) < LEXICAL_MIN_SEC:
            continue
        if (tail_end - tail_start) < LEXICAL_MIN_SEC:
            continue
        pieces.append({'start': head_start, 'end': head_end,
                       'words': indexes[head:k + 1]})
        head = k + 1

    if not pieces:
        return [span]

    start, end = _bounds(words, indexes[head:])
    pieces.append({'start': start, 'end': max(end, span['end']),
                   'words': indexes[head:]})
    return pieces


def _read_wav(path):
    """The front-end always sends 16 kHz mono PCM, so this stays simple."""
    import numpy as np
    try:
        with wave.open(path, 'rb') as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2:
                return None, 0
            raw = w.readframes(w.getnframes())
            rate = w.getframerate()
    except Exception:
        return None, 0
    return np.frombuffer(raw, dtype='<i2').astype('float32') / 32768.0, rate


def _pick_device():
    import torch
    if torch.cuda.is_available():
        return 'cuda'
    if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


def _load_encoder(device=None):
    """
    @returns (encoder, device) — the device may not be the one asked for.

    SpeechBrain 1.1 maps only 'cpu' and 'cuda' to an autocast device type, so
    asking it for MPS raises before the model is even built. Rather than pinning
    Apple Silicon to the CPU for good — a later release may well handle it — the
    accelerator is tried and the CPU is used if it is refused. ECAPA is a small
    model, so that fallback is a slower pass, not a failure.
    """
    try:
        from speechbrain.inference.speaker import EncoderClassifier
    except ImportError:  # speechbrain < 1.0
        from speechbrain.pretrained import EncoderClassifier

    repo = registry.ECAPA_MODEL['repo']
    # SpeechBrain wants a working directory of its own for the checkpoint. It
    # fetches through huggingface_hub, so the download itself still lands in the
    # shared cache the Settings panel installs into and reports on.
    savedir = os.path.join(registry.hf_cache_dir(), 'speechbrain',
                           repo.replace('/', '--'))

    def build(dev):
        return EncoderClassifier.from_hparams(source=repo, savedir=savedir,
                                              run_opts={'device': dev})

    device = device or _pick_device()
    try:
        return build(device), device
    except Exception:
        if device == 'cpu':
            raise
        return build('cpu'), 'cpu'


def _embed(encoder, device, samples, rate, spans, progress_cb=None):
    """
    One embedding per span, batched.

    Falls back to the CPU once if the accelerator refuses an operation, rather
    than losing the whole pass — ECAPA is small enough that CPU is a slowdown,
    not a wall.
    """
    import numpy as np
    import torch

    total = len(spans)
    vectors = []
    margins = _context_margins(spans)

    for offset in range(0, total, BATCH_SPANS):
        batch = spans[offset:offset + BATCH_SPANS]
        clips = [_clip(samples, rate, s, margins[offset + i])
                 for i, s in enumerate(batch)]
        width = max(len(c) for c in clips)

        padded = np.zeros((len(clips), width), dtype='float32')
        lengths = np.zeros(len(clips), dtype='float32')
        for i, clip in enumerate(clips):
            padded[i, :len(clip)] = clip
            lengths[i] = len(clip) / float(width)

        wavs = torch.from_numpy(padded)
        lens = torch.from_numpy(lengths)

        try:
            with torch.no_grad():
                out = encoder.encode_batch(wavs.to(device), lens.to(device))
        except Exception:
            if device == 'cpu':
                raise
            encoder, device = _load_encoder('cpu')
            with torch.no_grad():
                out = encoder.encode_batch(wavs, lens)

        vectors.append(out.squeeze(1).float().cpu().numpy())

        if progress_cb:
            done = min(offset + len(batch), total)
            progress_cb(0.1 + 0.75 * done / total,
                        f'Separating speakers… {done}/{total} passages')

    return np.vstack(vectors) if vectors else None


def _context_margins(spans):
    """
    How far either side of each span the encoder may reach.

    Never past the middle of the silence next to it, and so never at all where a
    span was cut at a sentence with no silence to speak of. Half a second of
    "In here," preceded by 0.15s of the person who just stopped talking is a
    third of the clip in the wrong voice, which is enough to swing the label to
    them — the very handover the cut exists to catch.
    """
    out = []
    for i, span in enumerate(spans):
        lead = CONTEXT_SEC if i == 0 else \
            min(CONTEXT_SEC, max(0.0, span['start'] - spans[i - 1]['end']) / 2.0)
        tail = CONTEXT_SEC if i == len(spans) - 1 else \
            min(CONTEXT_SEC, max(0.0, spans[i + 1]['start'] - span['end']) / 2.0)
        out.append((lead, tail))
    return out


def _clip(samples, rate, span, margin=(CONTEXT_SEC, CONTEXT_SEC)):
    """The audio for one span, with whatever context is safely its own."""
    import numpy as np
    lead, tail = margin
    floor = max(1, int(0.2 * rate))
    start = int(max(0.0, span['start'] - lead) * rate)
    end = int(min(len(samples) / float(rate), span['end'] + tail) * rate)
    if end - start < floor:
        end = min(len(samples), start + floor)
    clip = samples[start:end]
    # A word timed past the end of the audio — alignment can do that on the last
    # word — would otherwise hand the encoder an empty batch row.
    if len(clip) == 0:
        return np.zeros(floor, dtype='float32')
    return clip


def _normalise(matrix):
    import numpy as np
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def _cluster(embeddings, k=None):
    """
    Divisive clustering on cosine distance: one group in two at a time.

    Every split is judged by how much more alike each half is than the group it
    came from (the "spread", the mean distance between its members). That is a
    measure relative to the recording in hand, which is what a fixed threshold
    could never be — see MIN_VOICE_SPANS.

    With a known count, the split that tightens its group most is taken until
    there are k groups. Asked to find the count, a split is taken only where
    both halves are tighter than their parent: two people make two tight groups,
    while one voice cut in two leaves a loose remainder of its oddest spans.

    Splitting top-down rather than stopping a bottom-up merge part-way also
    stops a stray span from claiming a speaker. Merging forced to stop at k
    clusters keeps the k-1 most outlying spans apart and lumps everyone else
    together — a laugh becomes Speaker 2 and the actual second person is folded
    into Speaker 1.

    @param k  a known speaker count, or None to decide from the spans
    @returns  an array of group labels, 0..count-1
    """
    import numpy as np

    n = len(embeddings)
    if n == 0:
        return None
    if n == 1 or k == 1:
        return np.zeros(n, dtype=int)

    X = _normalise(embeddings.astype('float64'))
    distances = 1.0 - (X @ X.T)
    np.fill_diagonal(distances, 0.0)

    floor = max(2, int(round(MIN_GROUP_SHARE * n)))
    target = min(k or MAX_SPEAKERS, n)
    groups = [np.arange(n)]
    proposals = {}

    def propose(group, smallest):
        key = (group.tobytes(), smallest)
        if key not in proposals:
            halves = _split_in_two(distances, group, smallest)
            if halves is None:
                proposals[key] = None
            else:
                a, b = halves
                parent = _spread(distances, group)
                spread_a = _spread(distances, a)
                spread_b = _spread(distances, b)
                gain = parent - (len(a) * spread_a + len(b) * spread_b) / len(group)
                distinct = (spread_a < parent and spread_b < parent
                            and min(len(a), len(b)) >= MIN_VOICE_SPANS)
                proposals[key] = (gain, distinct, a, b)
        return proposals[key]

    def best_split(smallest):
        found = None
        for index, group in enumerate(groups):
            p = propose(group, smallest)
            if p is None or (k is None and not p[1]):
                continue
            if found is None or p[0] > found[0][0]:
                found = (p, index)
        return found

    while len(groups) < target:
        found = best_split(floor)
        # Told how many people there are, a split of a group too small to
        # satisfy the floor beats handing back fewer speakers than were asked
        # for: the operator knows the material better than the share does.
        if found is None and k is not None:
            found = best_split(1)
        if found is None:
            break
        (_, _, a, b), index = found
        groups[index:index + 1] = [a, b]

    labels = np.zeros(n, dtype=int)
    for label, group in enumerate(groups):
        labels[group] = label
    return labels


def _spread(distances, group):
    """Mean distance between the members of a group; 0 for a single span."""
    import numpy as np
    m = len(group)
    if m < 2:
        return 0.0
    # The diagonal is zero, so the full block sum is the sum over pairs.
    return float(distances[np.ix_(group, group)].sum() / (m * (m - 1)))


def _split_in_two(distances, group, smallest):
    """
    The top split of a group under average-linkage merging, ignoring strays.

    The group is merged bottom-up to one, and the split used is the last point
    at which two clusters of at least `smallest` spans still stood apart. The
    few spans still on their own at that point are not a third voice — they are
    the outliers the floor exists to keep out — so each joins whichever of the
    two it sits nearer on average.

    Average linkage rather than single: one borderline pair of spans should not
    be able to chain two speakers together, which is exactly what single linkage
    does on voices recorded in the same room.

    @returns (a, b) arrays of indexes into the full matrix, or None
    """
    import numpy as np
    m = len(group)
    if m < 2 * smallest:
        return None

    D = distances[np.ix_(group, group)].copy()
    np.fill_diagonal(D, np.inf)
    sizes = np.ones(m)

    # Merge to the top, recording the order, and note the last merge after
    # which two clusters of real size were still apart.
    merges = []
    big = m if smallest <= 1 else 0
    last_split = -1 if big >= 2 else None
    for step in range(m - 1):
        i, j = divmod(int(np.argmin(D)), m)
        before = int(sizes[i] >= smallest) + int(sizes[j] >= smallest)
        # Lance-Williams update for average linkage. Rows of clusters already
        # merged away stay infinite: inf * weight is still inf.
        merged = (sizes[i] * D[i] + sizes[j] * D[j]) / (sizes[i] + sizes[j])
        D[i] = merged
        D[:, i] = merged
        D[i, i] = np.inf
        D[j] = np.inf
        D[:, j] = np.inf
        sizes[i] += sizes[j]
        sizes[j] = 0
        merges.append((i, j))
        big += int(sizes[i] >= smallest) - before
        if big >= 2:
            last_split = step

    if last_split is None:
        return None

    members = {i: [i] for i in range(m)}
    for i, j in merges[:last_split + 1]:
        members[i].extend(members.pop(j))

    clusters = sorted(members.values(), key=len, reverse=True)
    a, b = list(clusters[0]), list(clusters[1])
    for stray in clusters[2:]:
        for s in stray:
            to_a = distances[group[s], group[a]].mean()
            to_b = distances[group[s], group[b]].mean()
            (a if to_a <= to_b else b).append(s)
    return group[np.array(a)], group[np.array(b)]


def _centroids(embeddings, labels):
    import numpy as np
    count = int(labels.max()) + 1
    out = np.zeros((count, embeddings.shape[1]), dtype='float64')
    normalised = _normalise(embeddings.astype('float64'))
    for label in range(count):
        rows = normalised[labels == label]
        if len(rows):
            out[label] = rows.mean(axis=0)
    return _normalise(out)


def _nearest(embeddings, centroids):
    """Every span — including the short ones held out of clustering — gets the
    closest voice, so no word is left without a speaker."""
    import numpy as np
    similarity = _normalise(embeddings.astype('float64')) @ centroids.T
    return np.argmax(similarity, axis=1)


def _smooth(spans, labels):
    """
    Flip a brief span sandwiched between two spans that agree with each other.

    Only inside an unbroken run of speech. A short span with a pause either side
    is somebody interrupting — "Good", "Exactly", "No" — and those one-word
    turns are precisely what speaker labelling exists to catch; a short span mid
    -flow, with no pause anywhere near it, is a clustering wobble.
    """
    for i in range(1, len(spans) - 1):
        if (spans[i]['end'] - spans[i]['start']) > SMOOTH_MAX_SEC:
            continue
        if (spans[i]['start'] - spans[i - 1]['end']) >= SPLIT_PAUSE_SEC:
            continue
        if (spans[i + 1]['start'] - spans[i]['end']) >= SPLIT_PAUSE_SEC:
            continue
        before, after = labels[i - 1], labels[i + 1]
        if before == after and labels[i] != before:
            labels[i] = before
    return labels


def _settle(words, spans, labels):
    """
    Drop a change of speaker that lands somewhere a speaker cannot change.

    Every span edge is a pause, the end of a sentence, or neither — the last
    kind being the arbitrary cut a span takes when it runs past MAX_SPAN_SEC,
    which falls mid-clause with no silence around it. Nobody hands over a line
    there. A label that changes across such an edge is the clustering drifting
    part-way through one person's sentence, and it costs the operator a word:
    the caption is split at the change, and the fragment left behind is too
    short to grow into anything readable — a few frames on screen, which reads
    as a dropped word rather than as a second speaker.

    So a change is kept only where the words allow one, and otherwise the run
    carries on with the voice it started in.
    """
    for i in range(1, len(spans)):
        if labels[i] == labels[i - 1]:
            continue
        if (spans[i]['start'] - spans[i - 1]['end']) >= SPLIT_PAUSE_SEC:
            continue
        if _ends_sentence(words[spans[i - 1]['words'][-1]]):
            continue
        labels[i] = labels[i - 1]
    return labels


def _rename_in_first_appearance_order(spans, labels):
    """Speaker 1 is whoever talks first, which is what an operator expects."""
    order = {}
    for span, label in zip(spans, labels):
        label = int(label)
        if label not in order:
            order[label] = f'Speaker {len(order) + 1}'
    return order


def _turns(spans):
    """Consecutive spans by the same person become one turn."""
    turns = []
    for span in spans:
        if turns and turns[-1]['speaker'] == span['speaker']:
            turns[-1]['end'] = float(span['end'])
        else:
            turns.append({'start': float(span['start']),
                          'end': float(span['end']),
                          'speaker': span['speaker']})
    return turns
