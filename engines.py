"""
Transcription engine adapters and the forced aligner.

Every adapter exposes the same shape:

    engine = SomeEngine(model_desc, options)
    engine.load(progress_cb)
    result = engine.transcribe(wav_path, options, progress_cb)
        -> {'segments': [...], 'words': [...], 'language': str|None}

Recognition and timing are deliberately separate concerns. The most accurate
models available are LLM-backbone designs that return text without usable word
times, which is fine for a transcript and useless for captions. Rather than
ruling those models out, the ForcedAligner attaches precise per-word times to
whatever transcript comes back, so model choice and timing quality stop being
the same decision.
"""

import os
import re
import wave

import model_registry as registry
import vocabulary as vocab


class EngineError(RuntimeError):
    pass


class _Unit:
    """Minimal token-like holder so chunk lists can reuse words_from_tokens()."""
    __slots__ = ('text', 'start', 'end')

    def __init__(self, text, start, end):
        self.text = text or ''
        self.start = start
        self.end = end


def _read_wav_mono16k(path):
    """The front-end always sends 16 kHz mono PCM, so this stays simple."""
    with wave.open(path, 'rb') as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise EngineError(
                'Internal error: expected 16-bit mono PCM audio, got '
                f'{w.getnchannels()}-channel {w.getsampwidth() * 8}-bit at '
                f'{w.getframerate()} Hz.')
        frames = w.readframes(w.getnframes())
        rate = w.getframerate()
    import array
    samples = array.array('h')
    samples.frombytes(frames)
    return samples, rate


def _quiet_chunks(samples, rate, max_len, search_sec=6.0, frame_sec=0.05):
    """
    Splits audio into windows no longer than max_len samples, ending each one
    at the quietest moment in its last few seconds rather than at a fixed
    mark. A cut through the middle of a word garbles it on both sides of the
    join; a cut in a breath between words costs nothing.

    Yields (start, stop) sample ranges covering the whole signal.
    """
    total = len(samples)
    frame = max(1, int(frame_sec * rate))
    search = int(search_sec * rate)
    start = 0
    while start < total:
        limit = start + max_len
        if limit >= total:
            yield start, total
            return
        best, best_energy = limit, None
        # Score each short frame in the search zone by its energy and take the
        # quietest; ties go to the later frame so windows stay full.
        pos = max(start + frame, limit - search)
        while pos + frame <= limit:
            energy = 0
            for i in range(pos, pos + frame, 4):   # every 4th sample is plenty
                v = samples[i]
                energy += v * v
            if best_energy is None or energy <= best_energy:
                best, best_energy = pos + frame // 2, energy
            pos += frame
        yield start, best
        start = best


def supported_kwargs(func, candidates):
    """
    Keep only the arguments `func` actually accepts.

    Biasing arguments come and go between releases — faster-whisper's `hotwords`
    is recent, for instance — and passing an unknown one raises rather than being
    ignored. Filtering keeps a newer feature usable without pinning a version.
    """
    if not candidates:
        return {}
    try:
        import inspect
        params = inspect.signature(func).parameters
        if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
            return dict(candidates)
        return {k: v for k, v in candidates.items() if k in params}
    except (TypeError, ValueError):
        return {}


class BaseEngine:
    def __init__(self, model_desc, options=None):
        self.model = model_desc
        self.options = options or {}
        self.handle = None

    def bias_kwargs(self, func):
        """Native vocabulary biasing for this engine, where it is supported."""
        terms = self.options.get('terms') or []
        candidates = vocab.engine_prompt_kwargs(self.model.get('engine'), terms)
        return supported_kwargs(func, candidates)

    def keep_uncertain_kwargs(self, func):
        """
        Stand Whisper's own gate down, where the operator has asked for the
        passages it would have discarded.

        Whisper carries a no-speech probability per window, and where that is
        high and the decode came out weak it drops the whole thirty seconds and
        seeks past them — no words, no timings, nothing to notice afterwards
        except a hole. Two people talking over each other reads exactly like
        that from inside the decoder, and so does a hard cut into a new scene.
        Standing the gate down also restores the temperature retries, which the
        same check calls off on the grounds that the window is only silence.

        What it does not do is stop silence being dropped. That is still done
        afterwards, by the level detector, which measures the audio rather than
        inferring it from how the decode went.
        """
        if not self.options.get('keep_uncertain'):
            return {}
        return supported_kwargs(func, {'no_speech_threshold': None})

    @property
    def repo(self):
        custom = (self.options.get('custom_model') or '').strip()
        if custom:
            return os.path.expanduser(custom) if os.path.isdir(os.path.expanduser(custom)) else custom
        return self.model['repo']

    def load(self, progress_cb=None):
        raise NotImplementedError

    def transcribe(self, wav_path, options, progress_cb=None):
        raise NotImplementedError

    @staticmethod
    def _lang(options):
        lang = options.get('language')
        return None if lang in (None, '', 'auto') else lang


class MlxWhisperEngine(BaseEngine):
    """Whisper on the Apple GPU through MLX."""

    def load(self, progress_cb=None):
        try:
            import mlx_whisper  # noqa: F401
        except ImportError:
            raise EngineError('The MLX Whisper runtime is not installed. Install it from Settings → Speech Runtimes.')
        self.handle = True

    def transcribe(self, wav_path, options, progress_cb=None):
        import mlx_whisper
        if progress_cb:
            progress_cb(0.1, 'Running Whisper on the Apple GPU…')

        raw = mlx_whisper.transcribe(
            wav_path,
            path_or_hf_repo=self.repo,
            language=self._lang(options),
            task=options.get('task') or 'transcribe',
            word_timestamps=True,
            # Carrying context improves coherence but can send the decoder into
            # a repetition loop on music and room tone, so it is opt-in.
            condition_on_previous_text=bool(options.get('carry_context', False)),
            **self.keep_uncertain_kwargs(mlx_whisper.transcribe),
            **self.bias_kwargs(mlx_whisper.transcribe),
        )

        segments, words = [], []
        for seg in raw.get('segments', []) or []:
            seg_words = []
            for w in (seg.get('words') or []):
                item = {
                    'word': w.get('word', ''),
                    'start': float(w.get('start', seg.get('start', 0))),
                    'end': float(w.get('end', seg.get('end', 0))),
                    'probability': float(w.get('probability', 1.0) or 1.0),
                }
                seg_words.append(item)
                words.append(item)
            segments.append({
                'start': float(seg.get('start', 0)),
                'end': float(seg.get('end', 0)),
                'text': (seg.get('text') or '').strip(),
                'words': seg_words,
            })

        return {'segments': segments, 'words': words,
                'language': raw.get('language'), 'text': raw.get('text', '')}


def _token_text(tok):
    """Token text with the SentencePiece word-start marker turned into a space."""
    text = getattr(tok, 'text', None)
    if text is None:
        text = getattr(tok, 'token', '') or ''
    return str(text).replace('▁', ' ')


def words_from_tokens(tokens, sentence_text=''):
    """
    Group sub-word tokens into whole words, keeping their timings.

    Token-level models emit SentencePiece pieces, not words: "Darren" arrives as
    ["▁D", "ar", "ren"] and punctuation as its own piece. Treating each piece as
    a word produces "D ar ren thought run ning" once the segmenter joins them
    with spaces, so the pieces have to be reassembled here.

    A new word starts at a piece that begins with whitespace (the marker), and
    the word inherits the first piece's start and the last piece's end. If the
    pieces carry no boundary markers at all, falls back to the model's own
    sentence text with timings distributed across it, so the words are always
    right even when the timings are approximate.
    """
    spans = []
    cursor = 0
    for tok in tokens:
        text = _token_text(tok)
        try:
            start = float(getattr(tok, 'start', 0.0) or 0.0)
            end = float(getattr(tok, 'end', start) or start)
        except (TypeError, ValueError):
            start = end = 0.0
        spans.append({'text': text, 'from': cursor, 'to': cursor + len(text),
                      'start': start, 'end': end})
        cursor += len(text)

    if not spans:
        return []

    joined = ''.join(s['text'] for s in spans)
    words = []
    for match in re.finditer(r'\S+', joined):
        lo, hi = match.start(), match.end()
        covering = [s for s in spans if s['to'] > lo and s['from'] < hi]
        if not covering:
            continue
        words.append({
            'word': match.group(0),
            'start': covering[0]['start'],
            'end': max(c['end'] for c in covering),
            'probability': 1.0,
        })

    # No boundary markers: everything concatenated into a single run. Use the
    # model's sentence text for the wording and spread the timings over it.
    expected = len(re.findall(r'\S+', sentence_text or ''))
    if expected > 1 and len(words) <= 1:
        return _distribute_words(sentence_text, spans[0]['start'],
                                 max(s['end'] for s in spans))

    return words


def _distribute_words(text, start, end):
    """Even fallback timing when per-word boundaries cannot be recovered."""
    parts = re.findall(r'\S+', text or '')
    if not parts:
        return []
    span = max(0.01, end - start)
    per = span / len(parts)
    return [{
        'word': part,
        'start': start + i * per,
        'end': start + (i + 1) * per,
        'probability': 1.0,
    } for i, part in enumerate(parts)]


class ParakeetMlxEngine(BaseEngine):
    """NVIDIA Parakeet on the Apple GPU through MLX. English, fast, accurate."""

    def load(self, progress_cb=None):
        try:
            from parakeet_mlx import from_pretrained
        except ImportError:
            raise EngineError('The Parakeet MLX runtime is not installed. Install it from Settings → Speech Runtimes.')
        if progress_cb:
            progress_cb(0.05, f'Loading {self.model["label"]}…')
        self.handle = from_pretrained(self.repo)

    def transcribe(self, wav_path, options, progress_cb=None):
        if progress_cb:
            progress_cb(0.1, 'Running Parakeet on the Apple GPU…')
        raw = self.handle.transcribe(wav_path)

        words, segments = [], []
        sentences = getattr(raw, 'sentences', None) or []

        for seg in sentences:
            seg_text = (getattr(seg, 'text', '') or '').strip()
            # Reassemble sub-word pieces into words before anything downstream
            # sees them; the caption segmenter joins words with spaces.
            seg_words = words_from_tokens(getattr(seg, 'tokens', None) or [], seg_text)
            words.extend(seg_words)
            segments.append({
                'start': float(getattr(seg, 'start', 0.0) or 0.0),
                'end': float(getattr(seg, 'end', 0.0) or 0.0),
                'text': seg_text or ' '.join(w['word'] for w in seg_words),
                'words': seg_words,
            })

        # Some builds report only a flat token list rather than sentences.
        if not sentences:
            flat = getattr(raw, 'tokens', None) or []
            raw_text = (getattr(raw, 'text', '') or '').strip()
            words = words_from_tokens(flat, raw_text)
            if words or raw_text:
                segments = [{
                    'start': words[0]['start'] if words else 0.0,
                    'end': words[-1]['end'] if words else 0.0,
                    'text': raw_text or ' '.join(w['word'] for w in words),
                    'words': words,
                }]

        text = (getattr(raw, 'text', '') or '').strip() \
            or ' '.join(s['text'] for s in segments).strip()

        # v2 is English-only; v3 identifies the language itself and does not
        # report it, so echo back what was asked for.
        language = 'en' if self.model.get('english_only') else self._lang(options)
        return {'segments': segments, 'words': words, 'language': language, 'text': text}


class Qwen3AsrMlxEngine(BaseEngine):
    """Qwen3-ASR on the Apple GPU. Text only — the aligner supplies timings."""

    def load(self, progress_cb=None):
        try:
            import mlx_qwen3_asr  # noqa: F401
        except ImportError:
            raise EngineError('The Qwen3-ASR MLX runtime is not installed. Install it from Settings → Speech Runtimes.')
        self.handle = True

    def transcribe(self, wav_path, options, progress_cb=None):
        import mlx_qwen3_asr
        if progress_cb:
            progress_cb(0.1, 'Running Qwen3-ASR on the Apple GPU…')

        raw = mlx_qwen3_asr.transcribe(
            wav_path,
            path_or_hf_repo=self.repo,
            language=self._lang(options),
            **self.bias_kwargs(mlx_qwen3_asr.transcribe),
        )
        text = raw.get('text', '') if isinstance(raw, dict) else str(raw)
        language = raw.get('language') if isinstance(raw, dict) else self._lang(options)

        return {
            'segments': [{'start': 0.0, 'end': 0.0, 'text': text.strip(), 'words': []}] if text.strip() else [],
            'words': [],
            'language': language,
            'text': text,
        }


class TransformersEngine(BaseEngine):
    """
    Generic Hugging Face path — Cohere Transcribe, Granite Speech, Distil-Whisper.
    Uses MPS on Apple Silicon, CUDA where present, otherwise CPU.
    """

    def _device(self):
        requested = self.options.get('device') or 'auto'
        try:
            import torch
            if requested != 'auto':
                return requested
            if torch.cuda.is_available():
                return 'cuda'
            if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
                return 'mps'
        except Exception:
            pass
        return 'cpu'

    def load(self, progress_cb=None):
        try:
            from transformers import pipeline
        except ImportError:
            raise EngineError('The Transformers + PyTorch runtime is not installed. '
                              'Install it from Settings → Speech Runtimes.')
        device = self._device()
        if progress_cb:
            progress_cb(0.05, f'Loading {self.model["label"]} on {device.upper()}…')
        self.device = device
        self.handle = pipeline(
            'automatic-speech-recognition',
            model=self.repo,
            device=device,
            chunk_length_s=30,
        )

    def transcribe(self, wav_path, options, progress_cb=None):
        if progress_cb:
            progress_cb(0.1, f'Transcribing on {self.device.upper()}…')

        generate_kwargs = {}
        lang = self._lang(options)
        if lang:
            generate_kwargs['language'] = lang
        if options.get('task'):
            generate_kwargs['task'] = options['task']

        terms = options.get('terms') or []
        if terms:
            prompt = vocab.build_prompt(terms)
            tokenizer = getattr(self.handle, 'tokenizer', None)
            get_prompt_ids = getattr(tokenizer, 'get_prompt_ids', None)
            if prompt and callable(get_prompt_ids):
                try:
                    generate_kwargs['prompt_ids'] = get_prompt_ids(prompt, return_tensors='pt')
                except Exception:
                    pass  # checkpoint does not support prompting

        wants_words = bool(self.model.get('word_timings'))
        try:
            raw = self.handle(wav_path,
                              return_timestamps='word' if wants_words else False,
                              generate_kwargs=generate_kwargs or None)
        except (ValueError, TypeError):
            # Not every checkpoint supports word timestamps or generate kwargs.
            raw = self.handle(wav_path)

        text = (raw.get('text') if isinstance(raw, dict) else str(raw)) or ''

        units = []
        for chunk in ((raw.get('chunks') if isinstance(raw, dict) else None) or []):
            ts = chunk.get('timestamp') or (None, None)
            if ts[0] is None:
                continue
            units.append(_Unit(chunk.get('text', ''),
                               float(ts[0]),
                               float(ts[1] if ts[1] is not None else ts[0] + 0.2)))

        # Whisper-family checkpoints return one chunk per word; CTC and some
        # LLM-backbone ones return sub-word pieces. Many more chunks than words
        # in the transcript means pieces, which have to be reassembled or the
        # captions come out as "D ar ren thought run ning".
        expected = len(re.findall(r'\S+', text))
        if expected and len(units) > expected * 1.5:
            words = words_from_tokens(units, text)
        else:
            words = [{'word': u.text.strip(), 'start': u.start, 'end': u.end,
                      'probability': 1.0} for u in units if u.text.strip()]

        segments = [{
            'start': words[0]['start'] if words else 0.0,
            'end': words[-1]['end'] if words else 0.0,
            'text': text.strip(),
            'words': words,
        }] if text.strip() else []

        return {'segments': segments, 'words': words, 'language': lang, 'text': text}


class GraniteSpeechEngine(BaseEngine):
    """
    IBM Granite Speech — an LLM-backbone model with its own audio processor
    and a chat-template prompt, called via AutoProcessor + generate() rather
    than pipeline('automatic-speech-recognition'). Its feature extractor's
    __call__ doesn't accept the `sampling_rate` kwarg the generic ASR pipeline
    passes, so TransformersEngine's path raises immediately on this model.
    Text only — the aligner supplies word timings.
    """

    # Undocumented by IBM; borrows the 30s window TransformersEngine already
    # uses for pipeline chunking, since bypassing the pipeline loses that.
    CHUNK_SECONDS = 30.0
    MAX_NEW_TOKENS = 320

    @staticmethod
    def _patch_projector_batch_bug(model):
        """
        GraniteSpeechEncoderProjector.forward() hands its learned query
        (batch 1) to the QFormer alongside encoder_hidden_states split into
        `nblocks` blocks (batch nblocks). CPU implicitly broadcasts the query
        across blocks; on MPS (confirmed on torch 2.13 / transformers 5.15)
        that broadcast silently collapses to batch 1 instead, so any audio
        needing more than one ~4s block fails downstream with
        "shape '[1, N, -1]' is invalid for input of size <one block>".
        Explicitly expanding the query is correct on every backend, so this
        is applied unconditionally rather than gated on device == 'mps'.
        """
        import math
        import types
        try:
            projector = model.model.projector
        except AttributeError:
            return
        if type(projector).__name__ != 'GraniteSpeechEncoderProjector':
            return

        def patched_forward(self, hidden_states):
            import torch.nn.functional as F
            batch_size, seq_len, dim = hidden_states.size()
            nblocks = math.ceil(seq_len / self.window_size)
            pad = nblocks * self.window_size - seq_len
            hidden_states = F.pad(hidden_states, (0, 0, 0, pad), 'constant', 0)
            hidden_states = hidden_states.view(batch_size * nblocks, self.window_size, dim)

            query_embeds = self.query.expand(batch_size * nblocks, -1, -1)
            query_output = self.qformer(
                query_embeds=query_embeds,
                encoder_hidden_states=hidden_states,
                encoder_attention_mask=None,
                return_dict=True,
            )
            return self.linear(
                query_output.last_hidden_state.reshape(
                    batch_size, nblocks * self.window_size // self.downsample_rate, -1))

        projector.forward = types.MethodType(patched_forward, projector)

    def _device(self):
        requested = self.options.get('device') or 'auto'
        try:
            import torch
            if requested != 'auto':
                return requested
            if torch.cuda.is_available():
                return 'cuda'
            if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
                return 'mps'
        except Exception:
            pass
        return 'cpu'

    def load(self, progress_cb=None):
        try:
            import torch
            from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
        except ImportError:
            raise EngineError('The Transformers + PyTorch runtime is not installed. '
                              'Install it from Settings → Speech Runtimes.')

        device = self._device()
        if progress_cb:
            progress_cb(0.05, f'Loading {self.model["label"]} on {device.upper()}…')

        try:
            processor = AutoProcessor.from_pretrained(self.repo)
            dtype = torch.bfloat16 if device == 'cuda' else torch.float32
            # No device_map= here: that path requires the `accelerate` package
            # for a plain single-device load, so just place the model directly.
            model = AutoModelForSpeechSeq2Seq.from_pretrained(
                self.repo, torch_dtype=dtype).to(device)
            self._patch_projector_batch_bug(model)
        except Exception as e:
            raise EngineError(
                f'Could not load {self.model["label"]}: {e}\n\n'
                'This model needs transformers>=4.52.1. If an older version is '
                'installed, reinstall the Transformers runtime from Settings → '
                'Speech Runtimes.')

        self.device = device
        self.processor = processor
        self.handle = model

    def transcribe(self, wav_path, options, progress_cb=None):
        import torch

        samples, rate = _read_wav_mono16k(wav_path)
        if not samples:
            return {'segments': [], 'words': [], 'language': self._lang(options), 'text': ''}

        tokenizer = self.processor.tokenizer
        instruction = 'transcribe the speech with proper punctuation and capitalization.'
        terms = options.get('terms') or []
        if terms:
            # Keep the punctuation request: without it the model returns bare
            # lowercase text, which is no use as a caption.
            instruction = ('transcribe the speech with proper punctuation and capitalization. '
                           f'Keywords: {", ".join(terms)}.')
        chat = [{'role': 'user', 'content': f'<|audio|>{instruction}'}]
        prompt = tokenizer.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)

        chunk_len = max(1, int(self.CHUNK_SECONDS * rate))
        total = len(samples)
        pieces = []

        for start, stop in _quiet_chunks(samples, rate, chunk_len):
            chunk = samples[start:stop]
            if not chunk:
                continue
            wav = torch.tensor(chunk.tolist(), dtype=torch.float32).div(32768.0).unsqueeze(0)

            model_inputs = self.processor(prompt, wav, device=self.device,
                                          return_tensors='pt').to(self.device)
            with torch.no_grad():
                out = self.handle.generate(**model_inputs, max_new_tokens=self.MAX_NEW_TOKENS,
                                           do_sample=False, num_beams=1)

            num_input_tokens = model_inputs['input_ids'].shape[-1]
            new_tokens = out[0, num_input_tokens:].unsqueeze(0)
            piece = tokenizer.batch_decode(new_tokens, add_special_tokens=False,
                                           skip_special_tokens=True)[0].strip()
            if piece:
                pieces.append(piece)

            if progress_cb:
                progress_cb(min(0.95, 0.1 + 0.85 * stop / total), 'Transcribing…')

        text = ' '.join(pieces)
        segments = [{'start': 0.0, 'end': total / float(rate or 16000),
                    'text': text, 'words': []}] if text else []

        return {'segments': segments, 'words': [], 'language': self._lang(options), 'text': text}


class FasterWhisperEngine(BaseEngine):
    """
    CTranslate2 Whisper. Note this has no Metal backend — on Apple Silicon it
    runs on CPU cores only and leaves the GPU idle, so the MLX engines are
    preferred there. Kept for CUDA machines and as a universal fallback.
    """

    def _device(self):
        requested = self.options.get('device') or 'auto'
        if requested != 'auto':
            return requested
        try:
            import torch
            if torch.cuda.is_available():
                return 'cuda'
        except Exception:
            pass
        return 'cpu'

    def load(self, progress_cb=None):
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise EngineError('The faster-whisper runtime is not installed. Install it from Settings → Speech Runtimes.')
        device = self._device()
        compute = self.options.get('compute_type') or ('float16' if device == 'cuda' else 'int8')
        if progress_cb:
            progress_cb(0.05, f'Loading {self.model["label"]} on {device.upper()}…')
        self.device = device
        self.handle = WhisperModel(self.repo, device=device, compute_type=compute)

    def transcribe(self, wav_path, options, progress_cb=None):
        segments_iter, info = self.handle.transcribe(
            wav_path,
            language=self._lang(options),
            task=options.get('task') or 'transcribe',
            word_timestamps=True,
            vad_filter=bool(options.get('vad', True)),
            beam_size=int(options.get('beam_size', 5)),
            condition_on_previous_text=bool(options.get('carry_context', False)),
            **self.keep_uncertain_kwargs(self.handle.transcribe),
            **self.bias_kwargs(self.handle.transcribe),
        )

        total = float(getattr(info, 'duration', 0) or 0)
        segments, words = [], []
        for seg in segments_iter:
            seg_words = []
            for w in (getattr(seg, 'words', None) or []):
                item = {'word': w.word, 'start': float(w.start), 'end': float(w.end),
                        'probability': float(getattr(w, 'probability', 1.0) or 1.0)}
                seg_words.append(item)
                words.append(item)
            segments.append({'start': float(seg.start), 'end': float(seg.end),
                             'text': seg.text.strip(), 'words': seg_words})
            if progress_cb and total > 0:
                progress_cb(min(0.95, float(seg.end) / total), 'Transcribing…')

        return {'segments': segments, 'words': words,
                'language': getattr(info, 'language', None),
                'text': ' '.join(s['text'] for s in segments)}


ENGINE_CLASSES = {
    registry.ENGINE_MLX_WHISPER: MlxWhisperEngine,
    registry.ENGINE_MLX_PARAKEET: ParakeetMlxEngine,
    registry.ENGINE_MLX_QWEN3: Qwen3AsrMlxEngine,
    registry.ENGINE_TRANSFORMERS: TransformersEngine,
    registry.ENGINE_GRANITE_SPEECH: GraniteSpeechEngine,
    registry.ENGINE_FASTER_WHISPER: FasterWhisperEngine,
}


def build_engine(model_desc, options=None):
    cls = ENGINE_CLASSES.get(model_desc['engine'])
    if not cls:
        raise EngineError(f"Unknown engine '{model_desc['engine']}'.")
    return cls(model_desc, options)


# ---------------------------------------------------------------------------
# Forced alignment
# ---------------------------------------------------------------------------

class ForcedAligner:
    """
    Attaches precise per-word times to an existing transcript using CTC forced
    alignment.

    This is what makes the accuracy-tier models usable for subtitling: they
    recognise the words well but report no timings, and Whisper's own timings
    are inferred from cross-attention and drift by a hundred milliseconds or
    more. Alignment is a separate, cheap pass that pins each word to the audio.
    """

    def __init__(self, repo=None):
        self.repo = repo or registry.ALIGNER_MODEL['repo']
        self.bundle = None

    def available(self):
        try:
            import torch, torchaudio  # noqa: F401
            return True
        except Exception:
            return False

    def align(self, wav_path, text, language=None, progress_cb=None):
        """
        @returns list of {word, start, end} or None when alignment is unavailable.
        Never raises — a failure here must not lose an otherwise good transcript.
        """
        words = [w for w in re.split(r'\s+', (text or '').strip()) if w]
        if not words:
            return []

        try:
            import torch
            import torchaudio
            from torchaudio.pipelines import MMS_FA as bundle
        except Exception:
            return None

        try:
            if progress_cb:
                progress_cb(0.9, 'Aligning word timings…')

            # Not torchaudio.load(): recent torchaudio releases route file I/O
            # through the optional `torchcodec` package, which is not part of
            # this app's runtime, and would raise ImportError here. The
            # front-end always sends 16-bit mono PCM at 16 kHz (audio_tools.py,
            # transcription.js), so reading it directly sidesteps that backend
            # entirely instead of adding another dependency for a format this
            # app already fully controls.
            samples, sample_rate = _read_wav_mono16k(wav_path)
            if not samples:
                return None
            waveform = torch.tensor(samples.tolist(), dtype=torch.float32).div(32768.0).unsqueeze(0)
            if sample_rate != bundle.sample_rate:
                waveform = torchaudio.functional.resample(waveform, sample_rate, bundle.sample_rate)

            device = 'cpu'
            if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
                device = 'mps'
            elif torch.cuda.is_available():
                device = 'cuda'

            model = bundle.get_model().to(device)
            tokenizer = bundle.get_tokenizer()
            aligner = bundle.get_aligner()

            with torch.inference_mode():
                emission, _ = model(waveform.to(device))
                # torchaudio::forced_align has no MPS kernel (PyTorch #141287),
                # so only this final, cheap alignment step runs on CPU — the
                # expensive encoder forward pass above still uses the GPU.
                token_spans = aligner(emission[0].cpu(), tokenizer(self._normalise(words)))

            ratio = waveform.shape[1] / emission.shape[1] / bundle.sample_rate
            out = []
            for word, spans in zip(words, token_spans):
                if not spans:
                    continue
                out.append({
                    'word': word,
                    'start': float(ratio * spans[0].start),
                    'end': float(ratio * spans[-1].end),
                    'probability': float(sum(s.score for s in spans) / len(spans)),
                })
            return out
        except Exception:
            # Alignment is an enhancement; the transcript still stands without it.
            return None

    @staticmethod
    def _normalise(words):
        """MMS_FA expects lowercase tokens without punctuation."""
        out = []
        for w in words:
            cleaned = re.sub(r"[^\w'’]", '', w.lower())
            out.append(cleaned or w.lower())
        return out
