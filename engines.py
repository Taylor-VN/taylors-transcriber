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

Segments carry timing even when words do not. An engine that splits the audio
itself (Granite, Nemotron) returns one segment per chunk with that chunk's real
`start`/`end` in seconds, so the aligner can align each piece of text against
its own window of audio rather than the whole file at once — cheaper, and a
failure is confined to one window. A segment whose `end` is not greater than
its `start` carries no timing and is treated as belonging to the whole file.
"""

import os
import re
import wave

import model_registry as registry
import vocabulary as vocab


# Generation-loop guardrail, from the Nemotron 3.5 Transcribe report
# (appendix E), itself following Qwen3-ASR's detect_and_fix_repetitions. An
# LLM-backbone recogniser occasionally fails to stop and repeats a character or
# a phrase until it hits the token limit. A run of twenty exact copies almost
# never occurs in a real transcript, so collapsing it is safe; it cannot recover
# the speech skipped while the model looped, but it stops the caption track
# filling with the same sentence.
_LOOP_CHAR_RUN = re.compile(r'(.)\1{20,}', re.DOTALL)
_LOOP_BLOCK_RUN = re.compile(r'(.{1,4096}?)\1{19,}', re.DOTALL)


def collapse_generation_loops(text):
    """Collapse runaway repetitions in decoded text. Character pass first."""
    if not text:
        return text
    text = _LOOP_CHAR_RUN.sub(lambda m: m.group(1), text)
    return _LOOP_BLOCK_RUN.sub(lambda m: m.group(1), text)


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
    """
    Qwen3-ASR on the Apple GPU. Text only — the aligner supplies timings.

    The package splits long audio into ~30 s chunks itself. return_chunks=True
    exposes each chunk's text with its real start/end, which are passed on as
    time-bounded segments so ForcedAligner aligns each chunk against its own
    window of audio (Qwen3 aligner where installed, MMS otherwise) instead of
    one pass over the whole file. Word timings are deliberately NOT requested
    from mlx_qwen3_asr here: its built-in aligner aborts the whole transcription
    if one chunk fails (e.g. Japanese without the optional nagisa package) and
    returns punctuation-stripped tokens, whereas ForcedAligner isolates failures
    per window, falls back to MMS, and keeps the original punctuation.
    """

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

        # The checkpoint argument is `model` from 0.2 on; early releases called
        # it `path_or_hf_repo`, and passing the wrong one raises TypeError.
        model_arg = supported_kwargs(mlx_qwen3_asr.transcribe, {'model': self.repo}) \
            or supported_kwargs(mlx_qwen3_asr.transcribe, {'path_or_hf_repo': self.repo})
        raw = mlx_qwen3_asr.transcribe(
            wav_path,
            language=self._lang(options),
            **model_arg,
            **supported_kwargs(mlx_qwen3_asr.transcribe, {'return_chunks': True}),
            **self.bias_kwargs(mlx_qwen3_asr.transcribe),
        )

        def field(name, default=None):
            # TranscriptionResult is a dataclass from 0.2 on; older releases
            # returned a dict.
            if isinstance(raw, dict):
                return raw.get(name, default)
            return getattr(raw, name, default)

        language = field('language') or self._lang(options)
        if language == 'unknown':
            language = self._lang(options)
        elif language and str(language).strip().lower() in _NAME_TO_CODE:
            language = _NAME_TO_CODE[str(language).strip().lower()]   # 'English' -> 'en'

        segments = []
        for chunk in (field('chunks') or []):
            text = collapse_generation_loops((chunk.get('text') or '')).strip()
            if not text:
                continue
            start = float(chunk.get('start') or 0.0)
            end = float(chunk.get('end') or 0.0)
            segments.append({'start': start, 'end': end, 'text': text, 'words': []})

        if segments:
            try:
                from mlx_qwen3_asr.tokenizer import join_text_parts
                text = join_text_parts([s['text'] for s in segments], language)
            except Exception:
                text = ' '.join(s['text'] for s in segments)
        else:
            whole = field('text', raw if isinstance(raw, str) else '') or ''
            text = collapse_generation_loops(str(whole)).strip()
            segments = [{'start': 0.0, 'end': 0.0, 'text': text, 'words': []}] if text else []

        return {'segments': segments, 'words': [], 'language': language, 'text': text}


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
    Text only — the aligner supplies word timings. Used for both Granite
    Speech 5.0 and the older 4.1, which share an architecture.
    """

    # IBM's card allows segments of up to ~2 minutes; 30s borrows the window
    # TransformersEngine uses for pipeline chunking and keeps each chunk's
    # token budget small.
    CHUNK_SECONDS = 30.0
    MAX_NEW_TOKENS = 320
    PLAIN_INSTRUCTION = 'transcribe the speech with proper punctuation and capitalization.'
    # Template for keyword biasing; {terms} is the comma-joined vocabulary.
    KEYWORD_INSTRUCTION = 'transcribe the speech with proper punctuation and capitalization. Keywords: {terms}.'

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

    @staticmethod
    def _dtype(torch, device):
        return torch.bfloat16 if device == 'cuda' else torch.float32

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
            dtype = self._dtype(torch, device)
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
        self.dtype = dtype
        self.processor = processor
        self.handle = model

    def transcribe(self, wav_path, options, progress_cb=None):
        import torch

        samples, rate = _read_wav_mono16k(wav_path)
        if not samples:
            return {'segments': [], 'words': [], 'language': self._lang(options), 'text': ''}

        tokenizer = self.processor.tokenizer
        instruction = self.PLAIN_INSTRUCTION
        terms = options.get('terms') or []
        if terms:
            instruction = self.KEYWORD_INSTRUCTION.format(terms=', '.join(terms))
        chat = [{'role': 'user', 'content': f'<|audio|>{instruction}'}]
        prompt = tokenizer.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)

        chunk_len = max(1, int(self.CHUNK_SECONDS * rate))
        total = len(samples)
        sr = float(rate or 16000)
        segments = []

        for start, stop in _quiet_chunks(samples, rate, chunk_len):
            chunk = samples[start:stop]
            if not chunk:
                continue
            wav = torch.tensor(chunk.tolist(), dtype=torch.float32).div(32768.0).unsqueeze(0)

            model_inputs = self.processor(prompt, wav, device=self.device,
                                          return_tensors='pt').to(self.device)
            if self.dtype is not None:
                # Cast only the float features; ids and masks must stay integral.
                for k, v in list(model_inputs.items()):
                    if hasattr(v, 'is_floating_point') and v.is_floating_point():
                        model_inputs[k] = v.to(self.dtype)
            with torch.no_grad():
                out = self.handle.generate(**model_inputs, max_new_tokens=self.MAX_NEW_TOKENS,
                                           do_sample=False, num_beams=1)

            num_input_tokens = model_inputs['input_ids'].shape[-1]
            new_tokens = out[0, num_input_tokens:].unsqueeze(0)
            piece = tokenizer.batch_decode(new_tokens, add_special_tokens=False,
                                           skip_special_tokens=True)[0]
            piece = collapse_generation_loops(piece).strip()
            if piece:
                segments.append({'start': start / sr, 'end': stop / sr,
                                 'text': piece, 'words': []})

            if progress_cb:
                progress_cb(min(0.95, 0.1 + 0.85 * stop / total), 'Transcribing…')

        text = ' '.join(seg['text'] for seg in segments)
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


_NEMOTRON_LANGUAGE_NAMES = {
    'cs': 'Czech', 'nl': 'Dutch', 'en': 'English', 'fr': 'French', 'de': 'German',
    'hi': 'Hindi', 'it': 'Italian', 'ko': 'Korean', 'pl': 'Polish',
    'pt': 'Portuguese', 'ru': 'Russian', 'sk': 'Slovak', 'es': 'Spanish',
    'bg': 'Bulgarian', 'hr': 'Croatian', 'da': 'Danish', 'et': 'Estonian',
    'fi': 'Finnish', 'hu': 'Hungarian', 'ja': 'Japanese', 'lv': 'Latvian',
    'lt': 'Lithuanian', 'ro': 'Romanian', 'sl': 'Slovenian', 'sv': 'Swedish',
    'th': 'Thai', 'tr': 'Turkish', 'uk': 'Ukrainian', 'ar': 'Arabic',
    'bn': 'Bengali', 'zh': 'Chinese', 'el': 'Greek', 'he': 'Hebrew',
    'id': 'Indonesian', 'mt': 'Maltese', 'mr': 'Marathi', 'tl': 'Tagalog',
    'ta': 'Tamil', 'te': 'Telugu', 'vi': 'Vietnamese',
}


class NemotronMlxEngine(BaseEngine):
    """
    NVIDIA Nemotron 3.5 Transcribe on the Apple GPU through mlx-audio.

    An LLM-backbone recogniser, so it is prompted rather than configured: the
    instruction is the written-form transcription prompt the model was trained
    on and contextual biasing follows appendix A.5 of its technical report.
    Long recordings are cut at quiet points into windows of about three
    minutes, which is long enough for the decoder's context to help and short
    enough to bound memory and report progress.

    The official NVIDIA checkpoints keep the CTC timestamp head, so words come
    back with real times. A checkpoint without it still transcribes; the
    segments then carry window times only and the aligner supplies the words.
    """

    WINDOW_SECONDS = 180.0
    MAX_TOKENS = 4096                  # per window; ~3 minutes is well under this

    def load(self, progress_cb=None):
        try:
            import mlx_audio  # noqa: F401
            from mlx_audio.stt import load as load_stt
        except ImportError:
            raise EngineError('The MLX Audio runtime is not installed. Install it from Settings → Speech Runtimes.')
        if progress_cb:
            progress_cb(0.05, f'Loading {self.model["label"]}…')
        try:
            self.handle = load_stt(self.repo, strict=True)
        except Exception as e:
            raise EngineError(f'Could not load {self.model["label"]}: {e}')
        # The checkpoint carries NVIDIA's CTC timing head, but mlx-audio's port
        # of it is not trustworthy yet: on a 12.5 s clip with two voices it put
        # every word inside the first 7.2 s, without raising (mlx-audio 0.6.5),
        # and other multi-voice windows fail outright with "No finite CTC
        # alignment path". Misplaced timings are worse than none for captions,
        # so they are only requested when the registry entry opts in; otherwise
        # the forced aligner times each window.
        self.has_timings = (bool(self.model.get('word_timings'))
                            and getattr(self.handle, 'ctc_timestamp', None) is not None)

    @staticmethod
    def _instruction(language, terms):
        # The wording the model was trained on for written-form output (report
        # fig. 6, "Written form"), which gives "6:30", "$45" and "March 3rd" —
        # what a caption wants. Measured on the 4-bit checkpoint, the report's
        # structured instruction (appendix A.1) and looser paraphrases return
        # numbers as words, and asking to drop fillers flips the style
        # unpredictably, so this phrasing is kept exactly. A named language
        # follows appendix A.5's "Transcribe the English audio" form.
        name = _NEMOTRON_LANGUAGE_NAMES.get(language.lower().split('-')[0]) if language else None
        text = (f'Transcribe the {name + " " if name else ""}audio in written form: '
                'render numbers, currencies, and dates using digits and symbols.')
        if terms:
            # Appendix A.5: the model is trained to ignore listed terms that are
            # not spoken, so the same list is safe for every window.
            text = ('This audio may contain the following words or phrases '
                    f'(some may not be present in the clip): {", ".join(terms)}.\n') + text
        return text

    def transcribe(self, wav_path, options, progress_cb=None):
        import numpy as np

        language = self._lang(options)
        samples, rate = _read_wav_mono16k(wav_path)
        total = len(samples)
        if not total:
            return {'segments': [], 'words': [], 'language': language, 'text': ''}

        prompt = self._instruction(language, options.get('terms') or [])
        window = max(1, int(self.WINDOW_SECONDS * rate))
        segments, texts = [], []

        def run(audio, timed):
            return self.handle.generate(
                audio, prompt=prompt, language=language, temperature=0.0,
                max_tokens=self.MAX_TOKENS, enable_thinking=False,
                word_timestamps=timed)

        # The timing head is all-or-nothing for a recording. It aligns the whole
        # transcript to a single speaker, so a window in which two people talk
        # has no valid path ("No finite CTC alignment path"). Half a timeline of
        # real times and half of none would be worse than either, so the first
        # failure turns timings off for the rest and discards the earlier ones;
        # the forced aligner then times the whole recording, window by window.
        timed_ok = self.has_timings

        for start, stop in _quiet_chunks(samples, rate, window):
            if stop <= start:
                continue
            audio = np.frombuffer(samples[start:stop].tobytes(), dtype=np.int16)
            audio = audio.astype(np.float32) / 32768.0
            offset = start / float(rate)
            out = None
            if timed_ok:
                try:
                    out = run(audio, True)
                except Exception:
                    timed_ok = False
            if out is None:
                out = run(audio, False)
            raw_text = (out.text or '').strip()
            text = collapse_generation_loops(raw_text)
            timed = []
            if timed_ok and text == raw_text:
                for w in (out.segments or []):
                    word = (w.get('text') or '').strip()
                    if word:
                        timed.append({'word': word,
                                      'start': offset + float(w['start']),
                                      'end': offset + float(w['end']),
                                      'probability': 1.0})
            elif timed_ok:
                timed_ok = False     # a collapsed loop no longer matches its times
            if text:
                texts.append(text)
                segments.append({'start': offset, 'end': stop / float(rate),
                                 'text': text, 'words': timed})
            if progress_cb:
                progress_cb(min(0.95, stop / total), 'Transcribing…')
            try:
                import mlx.core as mx
                mx.clear_cache()
            except Exception:
                pass

        if not timed_ok:
            for seg in segments:
                seg['words'] = []
        words = [w for seg in segments for w in seg['words']]

        return {'segments': segments, 'words': words, 'language': language,
                'text': ' '.join(texts)}


ENGINE_CLASSES = {
    registry.ENGINE_MLX_WHISPER: MlxWhisperEngine,
    registry.ENGINE_MLX_PARAKEET: ParakeetMlxEngine,
    registry.ENGINE_MLX_QWEN3: Qwen3AsrMlxEngine,
    registry.ENGINE_TRANSFORMERS: TransformersEngine,
    registry.ENGINE_GRANITE_SPEECH: GraniteSpeechEngine,
    registry.ENGINE_FASTER_WHISPER: FasterWhisperEngine,
    registry.ENGINE_MLX_AUDIO: NemotronMlxEngine,
}


def build_engine(model_desc, options=None):
    cls = ENGINE_CLASSES.get(model_desc['engine'])
    if not cls:
        raise EngineError(f"Unknown engine '{model_desc['engine']}'.")
    return cls(model_desc, options)


# ---------------------------------------------------------------------------
# Forced alignment
# ---------------------------------------------------------------------------

import importlib.util
import unicodedata

# What the Qwen3 aligner can take. Both figures are from the model card for
# Qwen/Qwen3-ForcedAligner-0.6B: "timestamp prediction for arbitrary units
# within up to 5 minutes of speech in 11 languages". The language argument of
# mlx_qwen3_asr's ForcedAligner only changes how text is split into units (the
# prompt carries no language), which is why Latin-script text of unknown
# language can safely be passed as English.
QWEN_ALIGNER_LANGUAGES = frozenset({
    'Chinese', 'English', 'Cantonese', 'French', 'German', 'Italian',
    'Japanese', 'Korean', 'Portuguese', 'Russian', 'Spanish',
})
QWEN_ALIGNER_MAX_SECONDS = 295.0     # 300 s limit, minus a little headroom
WINDOW_PAD_SECONDS = 0.3
ALIGN_SAMPLE_RATE = 16000

# Fallback names for ISO codes when mlx_qwen3_asr (which owns the canonical map)
# is not importable — e.g. the MMS path on Windows or Linux.
_LANGUAGE_NAMES = {
    'en': 'English', 'zh': 'Chinese', 'yue': 'Cantonese', 'ja': 'Japanese',
    'ko': 'Korean', 'de': 'German', 'fr': 'French', 'es': 'Spanish',
    'ru': 'Russian', 'ar': 'Arabic', 'hi': 'Hindi', 'it': 'Italian',
    'pt': 'Portuguese', 'tr': 'Turkish', 'nl': 'Dutch',
}
_NAME_TO_CODE = {v.lower(): k for k, v in _LANGUAGE_NAMES.items()}


def _language_code(language):
    """Lower-case ISO-ish code for a language given as 'en', 'English', 'pt-BR'."""
    v = str(language or '').strip().lower().replace('_', '-')
    if not v or v in ('auto', 'unknown', 'none'):
        return None
    if v in ('cantonese', 'yue', 'zh-hk'):
        return 'yue'
    if v in _NAME_TO_CODE:
        return _NAME_TO_CODE[v]
    return v


def canonical_language_name(language):
    """'en' -> 'English'; None when unknown. Reuses mlx_qwen3_asr's alias table."""
    code = _language_code(language)
    if not code:
        return None
    if code == 'yue':
        return 'Cantonese'
    try:
        from mlx_qwen3_asr.tokenizer import canonicalize_language, language_is_known
        if language_is_known(str(language)):
            return canonicalize_language(str(language))
    except Exception:
        pass
    return _LANGUAGE_NAMES.get(code.split('-')[0])


# ---- text units -----------------------------------------------------------

def _is_kept_char(ch):
    """Same predicate as ForcedAlignTextProcessor.is_kept_char."""
    return ch == "'" or unicodedata.category(ch)[0] in 'LN'


def clean_align_token(token):
    return ''.join(ch for ch in token if _is_kept_char(ch))


def _is_han(ch):
    code = ord(ch)
    return (0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF
            or 0x20000 <= code <= 0x2A6DF or 0x2A700 <= code <= 0x2B73F
            or 0x2B740 <= code <= 0x2B81F or 0x2B820 <= code <= 0x2CEAF
            or 0xF900 <= code <= 0xFAFF)


def split_units(text):
    """
    The unit list every aligner output is 1:1 with: whitespace-separated words,
    except that each Han character is its own unit (Chinese has no spaces, so
    "words" would be whole sentences). Punctuation stays attached to the
    original word, and punctuation following a Han character sticks to it.
    A token with no letters or digits at all ("—") is still a unit.
    """
    out = []
    for tok in (text or '').split():
        mine, cur = [], ''
        for ch in tok:
            if _is_han(ch):
                if cur:
                    if clean_align_token(cur):
                        mine.append(cur)
                        cur = ''
                    elif mine:
                        mine[-1] += cur
                        cur = ''
                mine.append(cur + ch)
                cur = ''
            elif not clean_align_token(cur) and not _is_kept_char(ch) and mine:
                mine[-1] += ch
            else:
                cur += ch
        if cur:
            if clean_align_token(cur) or not mine:
                mine.append(cur)
            else:
                mine[-1] += cur
        out.extend(mine)
    return out


def reconcile_aligned_words(units, tokens):
    """
    Map the Qwen3 aligner's cleaned tokens back onto the original units.

    The aligner drops punctuation and may split text differently from the
    whitespace words (Han per character; nagisa/soynlp for Japanese/Korean), so
    tokens are laid out as a character timeline — a token's characters share
    its span evenly — and each unit takes the characters its cleaned form
    covers. Boundaries that coincide with token boundaries (the normal case)
    therefore come out exact.

    @param units   list[str] from split_units()
    @param tokens  objects with .text/.start_time/.end_time (or dicts/tuples)
    @returns list of {word, start, end, probability} 1:1 with `units`, or None
             if the cleaned text does not match (drift) — callers fall back.
    """
    chars = []
    for tok in tokens or []:
        if isinstance(tok, dict):
            text, s0, e0 = tok.get('text'), tok.get('start_time', tok.get('start')), \
                tok.get('end_time', tok.get('end'))
        elif isinstance(tok, (tuple, list)):
            text, s0, e0 = tok[0], tok[1], tok[2]
        else:
            text, s0, e0 = tok.text, tok.start_time, tok.end_time
        text = unicodedata.normalize('NFC', text or '')
        if not text:
            continue
        s0, e0 = float(s0), float(e0)
        step = (e0 - s0) / len(text)
        for i, ch in enumerate(text):
            chars.append((ch, s0 + step * i, s0 + step * (i + 1)))

    expected = [unicodedata.normalize('NFC', clean_align_token(u)) for u in units]
    if ''.join(expected) != ''.join(c[0] for c in chars):
        return None

    spans, pos = [], 0
    for e in expected:
        if e:
            spans.append([chars[pos][1], chars[pos + len(e) - 1][2]])
            pos += len(e)
        else:
            spans.append(None)
    if all(s is None for s in spans):
        return None

    # Units with nothing to align ("—", "...") sit in the gap after their
    # neighbour rather than being dropped.
    last_end = next(s[0] for s in spans if s is not None)
    for i, s in enumerate(spans):
        if s is None:
            spans[i] = [last_end, last_end]
        else:
            last_end = s[1]
    return [{'word': u, 'start': s[0], 'end': max(s[0], s[1]), 'probability': 1.0}
            for u, s in zip(units, spans)]


# ---- MMS text normalisation ------------------------------------------------

_MMS_ALPHABET = frozenset("abcdefghijklmnopqrstuvwxyz'")
_ASCII_FOLD = {
    'ß': 'ss', 'ẞ': 'SS', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE',
    'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D',
    'ð': 'd', 'Ð': 'D', 'þ': 'th', 'Þ': 'Th', 'ı': 'i', 'ħ': 'h',
    '’': "'", '‘': "'", 'ʼ': "'", '`': "'", '´': "'",
}
_UROMAN = None        # lazily-built Uroman, or False when unavailable


def _fold_ascii(s):
    """NFKD, strip combining marks, a small table for letters that do not decompose."""
    s = ''.join(_ASCII_FOLD.get(ch, ch) for ch in s)
    s = unicodedata.normalize('NFKD', s)
    return ''.join(ch for ch in s if not unicodedata.combining(ch))


def _romanise(s):
    """uroman (the MMS recipe) when importable, else accent folding."""
    global _UROMAN
    if s.isascii():
        return s
    if _UROMAN is None:
        try:
            import uroman
            _UROMAN = uroman.Uroman()
        except Exception:
            _UROMAN = False
    if _UROMAN:
        try:
            return _UROMAN.romanize_string(s)
        except Exception:
            pass
    return s


# Spoken glue words for the number formats worth special-casing. Languages not
# listed read the bare number, which is still right for the digits.
_PERCENT = {'en': 'percent', 'fr': 'pour cent', 'de': 'prozent', 'es': 'por ciento',
            'it': 'percento', 'pt': 'por cento', 'ru': 'процент', 'nl': 'procent'}
_POINT = {'en': 'point', 'fr': 'virgule', 'de': 'komma', 'es': 'coma', 'it': 'virgola',
          'pt': 'vírgula', 'ru': 'запятая', 'nl': 'komma'}
_CURRENCY = {
    '$': {'en': ('dollar', 'dollars', 'cent', 'cents'), 'fr': ('dollar', 'dollars', None, None),
          'de': ('dollar', 'dollar', None, None), 'es': ('dólar', 'dólares', None, None),
          'it': ('dollaro', 'dollari', None, None), 'pt': ('dólar', 'dólares', None, None),
          'ru': ('доллар', 'долларов', None, None)},
    '€': {'en': ('euro', 'euros', 'cent', 'cents'), 'fr': ('euro', 'euros', None, None),
          'de': ('euro', 'euro', None, None), 'es': ('euro', 'euros', None, None),
          'it': ('euro', 'euro', None, None), 'pt': ('euro', 'euros', None, None),
          'ru': ('евро', 'евро', None, None)},
    '£': {'en': ('pound', 'pounds', 'penny', 'pence')},
    '¥': {'en': ('yen', 'yen', None, None)},
}
_COMMA_DECIMAL = frozenset({'de', 'fr', 'es', 'it', 'pt', 'ru', 'nl', 'tr', 'pl', 'cs',
                            'sv', 'da', 'fi', 'uk', 'id', 'vi', 'ro', 'hu', 'sk', 'sl'})
_NUM_RE = re.compile(r"""
      (?P<cur>[$€£¥])\s?(?P<curnum>\d[\d.,]*\d|\d)
    | (?P<time>\b\d{1,2}:\d{2}(?::\d{2})?\b)
    | (?P<ord>\d+(?:st|nd|rd|th)\b)
    | (?P<num>\d[\d.,]*\d|\d)(?P<pct>\s?%)?
""", re.X)


def _num2words_lang(code):
    """
    The num2words language to use. Unknown language -> English (the best
    guess); a known language num2words cannot speak (Chinese, Hindi, ...) ->
    None, because English number words would be worse than no digits at all.
    """
    if code is None:
        return 'en'
    try:
        from num2words import CONVERTER_CLASSES
    except Exception:
        return None
    for cand in (code.replace('-', '_'), code.split('-')[0]):
        if cand in CONVERTER_CLASSES:
            return cand
        if cand.lower() in CONVERTER_CLASSES:
            return cand.lower()
    return None


class _NumberSpeller:
    def __init__(self, language):
        self.code = _language_code(language)
        self.lang = _num2words_lang(self.code)
        self.base = (self.lang or 'en').split('_')[0]

    def cardinal(self, n, **kw):
        from num2words import num2words
        try:
            return num2words(n, lang=self.lang, **kw)
        except Exception:
            # Out of range or unsupported form: digit by digit still sounds right.
            if kw or len(str(n)) > 40:
                return ' '.join(num2words(int(d), lang=self.lang) for d in str(n))
            raise

    def amount(self, s):
        """'1,000.50' / '3,5' / '45' -> spoken words."""
        if self.base in _COMMA_DECIMAL:
            if re.fullmatch(r'\d{1,3}(?:\.\d{3})+(?:,\d+)?', s):
                s = s.replace('.', '').replace(',', '.')
            else:
                s = s.replace(',', '.')
        else:
            if re.fullmatch(r'\d{1,3}(?:,\d{3})+(?:\.\d+)?', s):
                s = s.replace(',', '')
            else:
                s = s.replace(',', '.')
        if re.fullmatch(r'\d+', s):
            return self.cardinal(int(s))
        m = re.fullmatch(r'(\d+)\.(\d+)', s)
        if not m:        # "1.2.3" and friends: read each run of digits
            return ' '.join(self.cardinal(int(d)) for d in re.findall(r'\d+', s))
        frac = ' '.join(self.cardinal(int(d)) for d in m.group(2))
        return f"{self.cardinal(int(m.group(1)))} {_POINT.get(self.base, '')} {frac}"

    def replace(self, m):
        if self.lang is None:
            return ' '
        try:
            if m.group('cur'):
                sym, raw = m.group('cur'), m.group('curnum')
                names = _CURRENCY.get(sym, {}).get(self.base)
                dm = re.fullmatch(r'(\d[\d,.]*?)[.,](\d{2})', raw)
                if names and names[2] and dm and self.base == 'en':
                    whole, cents = int(re.sub(r'\D', '', dm.group(1))), int(dm.group(2))
                    out = f"{self.cardinal(whole)} {names[0] if whole == 1 else names[1]}"
                    if cents:
                        out += f" and {self.cardinal(cents)} {names[2] if cents == 1 else names[3]}"
                    return out
                spoken = self.amount(raw)
                if names:
                    one = re.fullmatch(r'0*1', raw) is not None
                    return f"{spoken} {names[0] if one else names[1]}"
                return spoken
            if m.group('time'):
                parts = [int(p) for p in m.group('time').split(':')]
                out = [self.cardinal(parts[0])]
                for mi in parts[1:]:
                    if mi:
                        if mi < 10 and self.base == 'en':
                            out.append('oh')
                        out.append(self.cardinal(mi))
                return ' '.join(out)
            if m.group('ord'):
                n = int(re.match(r'\d+', m.group('ord')).group(0))
                if self.base == 'en':
                    return self.cardinal(n, to='ordinal')
                return self.cardinal(n)
            raw = m.group('num')
            if self.base == 'en' and re.fullmatch(r'(1[1-9]|20)\d\d', raw):
                return self.cardinal(int(raw), to='year')
            spoken = self.amount(raw)
            if m.group('pct'):
                spoken += ' ' + _PERCENT.get(self.base, '')
            return spoken
        except Exception:
            return ' '


def expand_numbers(word, language=None):
    """Spell digits out ("6:30" -> "six thirty", "$45" -> "forty-five dollars")."""
    if not any(ch.isdecimal() for ch in word):
        return word
    # Digits from other scripts (Arabic-Indic, fullwidth) -> ASCII first.
    word = ''.join(str(unicodedata.decimal(ch)) if ch.isdecimal() and not ch.isascii() else ch
                   for ch in word)
    if importlib.util.find_spec('num2words') is None:
        return re.sub(r'\d+', ' ', word)
    return _NUM_RE.sub(_NumberSpeller(language).replace, word)


def mms_normalise(word, language=None):
    """
    One word reduced to the MMS alphabet (a-z and apostrophe). Never raises;
    returns '' when nothing is pronounceable (the caller maps that to the star).
    """
    try:
        w = expand_numbers(word, language)
        w = _fold_ascii(_romanise(w)).lower()
    except Exception:
        w = _fold_ascii(word).lower()
    return ''.join(ch for ch in w if ch in _MMS_ALPHABET).strip("'")


class ForcedAligner:
    """
    Attaches precise per-word times to an existing transcript using CTC forced
    alignment.

    This is what makes the accuracy-tier models usable for subtitling: they
    recognise the words well but report no timings, and Whisper's own timings
    are inferred from cross-attention and drift by a hundred milliseconds or
    more. Alignment is a separate, cheap pass that pins each word to the audio.

    Two backends, chosen per window of audio:

      * Qwen3-ForcedAligner (MLX, Apple Silicon) — preferred where it is already
        installed, the language is one of its 11 and the window is at most five
        minutes. Never downloaded implicitly.
      * torchaudio MMS_FA (CTC, any platform, 1000+ languages) — the fallback.
        Text is romanised and digits spelled out; a word with nothing
        pronounceable becomes the star token so it still occupies a slot.

    A window that cannot be aligned by either falls back to even distribution
    across its own time span, so one bad window never costs the rest.

    After align(): `last_error` (str|None), `backend_used` ('qwen3'|'mms'|
    'mixed'|None) and `distributed_windows` (count of even-distribution fallbacks).
    """

    def __init__(self, repo=None, backend='auto'):
        # `repo` is the Qwen3 aligner checkpoint. backend: 'auto' | 'qwen3' | 'mms'.
        self.repo = repo or registry.QWEN_ALIGNER_MODEL['repo']
        self.prefer = backend
        self.last_error = None
        self.backend_used = None
        self.distributed_windows = 0
        self.fallback_windows = 0
        self._mms = None
        self._qwen = None
        self._qwen_failed = False
        self._qwen_installed = None

    # ------------------------------------------------------------ capability
    def _torch_ok(self):
        try:
            import torch, torchaudio  # noqa: F401
            return True
        except Exception:
            return False

    def _qwen_ready(self):
        """Backend is usable at all (platform, package, weights already on disk)."""
        if self.prefer == 'mms' or self._qwen_failed:
            return False
        if not registry.is_apple_silicon():
            return False
        if importlib.util.find_spec('mlx_qwen3_asr') is None:
            return False
        if self._qwen_installed is None:
            path = os.path.expanduser(self.repo or '')
            self._qwen_installed = os.path.isdir(path) or registry.is_installed(self.repo)
        return self._qwen_installed

    def available(self):
        """Cheap: true if either backend could run."""
        if self.prefer != 'mms' and self._qwen_ready():
            return True
        return self.prefer != 'qwen3' and self._torch_ok()

    def _qwen_language(self, language, text):
        """
        Name to hand mlx_qwen3_asr, or None when Qwen3 should not be used.
        Known-but-unsupported languages are rejected; unknown ones are accepted
        when every letter is in a script the model handles.
        """
        name = canonical_language_name(language)
        if name is None and _language_code(language):
            return None                          # a language we cannot place
        if name is not None:
            if name not in QWEN_ALIGNER_LANGUAGES:
                return None
        else:
            for ch in text:
                if ch.isalpha() and not (
                        _is_han(ch) or 'LATIN' in unicodedata.name(ch, '')
                        or 'CYRILLIC' in unicodedata.name(ch, '')
                        or 'HIRAGANA' in unicodedata.name(ch, '')
                        or 'KATAKANA' in unicodedata.name(ch, '')
                        or 'HANGUL' in unicodedata.name(ch, '')):
                    return None
            name = 'English'                     # tokenisation only
        # Japanese/Korean tokenisers are optional extras; without them the
        # generic splitter (same as ours) is used, which the reconciler handles.
        if name == 'Japanese' and importlib.util.find_spec('nagisa') is None:
            return 'English'
        if name == 'Korean' and importlib.util.find_spec('soynlp') is None:
            return 'English'
        return name

    # --------------------------------------------------------------- loading
    @staticmethod
    def _load_audio(wav_path):
        import numpy as np
        # Not torchaudio.load(): recent torchaudio releases route file I/O
        # through the optional `torchcodec` package, which is not part of this
        # app's runtime. The front-end always sends 16-bit mono PCM at 16 kHz
        # (audio_tools.py, transcription.js), so reading it directly sidesteps
        # that entirely.
        samples, rate = _read_wav_mono16k(wav_path)
        if not len(samples):
            raise EngineError('The audio file is empty.')
        audio = np.frombuffer(samples, dtype=np.int16).astype(np.float32) / 32768.0
        if rate != ALIGN_SAMPLE_RATE:
            import torch, torchaudio
            audio = torchaudio.functional.resample(
                torch.from_numpy(audio).unsqueeze(0), rate, ALIGN_SAMPLE_RATE)[0].numpy()
        return audio

    def _mms_state(self):
        """Bundle, model, tokenizer and aligner — built once per instance."""
        if self._mms is None:
            import torch
            from torchaudio.pipelines import MMS_FA as bundle
            device = 'cpu'
            if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
                device = 'mps'
            elif torch.cuda.is_available():
                device = 'cuda'
            model = bundle.get_model().to(device).eval()
            self._mms = {'bundle': bundle, 'model': model, 'device': device,
                         'tokenizer': bundle.get_tokenizer(), 'aligner': bundle.get_aligner()}
        return self._mms

    def _qwen_aligner(self):
        if self._qwen is None:
            import mlx_qwen3_asr
            self._qwen = mlx_qwen3_asr.ForcedAligner(self.repo)
        return self._qwen

    # ------------------------------------------------------------------ MMS
    def _emission(self, wave):
        """
        Frame-level emissions for a 1-D float tensor. Long audio is run in
        30 s pieces with one second of context either side: self-attention over
        a whole recording is quadratic in its length, and CTC emissions are
        local enough that the join is invisible.
        """
        import torch
        st = self._mms_state()
        model, device = st['model'], st['device']
        n = wave.shape[0]
        core, ctx, frame = 30 * ALIGN_SAMPLE_RATE, ALIGN_SAMPLE_RATE, 320

        def run(piece):
            nonlocal model, device
            try:
                return model(piece.unsqueeze(0).to(device))[0][0].cpu()
            except Exception:
                if device == 'cpu':
                    raise
                # An op the accelerator lacks: finish on CPU and stay there.
                model = st['model'] = model.to('cpu')
                device = st['device'] = 'cpu'
                return model(piece.unsqueeze(0))[0][0].cpu()

        with torch.inference_mode():
            if n <= core + 2 * ctx:
                return run(wave)
            parts = []
            for s in range(0, n, core):
                a, b = max(0, s - ctx), min(n, s + core + ctx)
                em = run(wave[a:b])
                off = (s - a) // frame
                last = s + core >= n
                parts.append(em[off:] if last else em[off:off + core // frame])
            return torch.cat(parts, dim=0)

    def _align_mms(self, audio, units, language, pad_with_star=False):
        import torch
        st = self._mms_state()
        wave = torch.from_numpy(audio)
        emission = self._emission(wave)
        norm = [mms_normalise(u, language) or '*' for u in units]
        with torch.inference_mode():
            # torchaudio::forced_align has no MPS kernel (PyTorch #141287); the
            # emission is already on CPU, so only the cheap search happens here.
            # A star either side soaks up speech from the neighbouring window
            # that the padding drags in, so it cannot stretch the edge words.
            tokens = st['tokenizer'](['*'] + norm + ['*'] if pad_with_star else norm)
            spans = st['aligner'](emission, tokens)
            if pad_with_star:
                spans = spans[1:-1]
        ratio = wave.shape[0] / emission.shape[0] / ALIGN_SAMPLE_RATE
        out = []
        for unit, sp in zip(units, spans):
            if not sp:
                return None
            out.append({'word': unit, 'start': float(ratio * sp[0].start),
                        'end': float(ratio * sp[-1].end),
                        'probability': float(sum(s.score for s in sp) / len(sp))})
        return out

    # ----------------------------------------------------------------- Qwen3
    def _align_qwen(self, audio, text, units, lang_name):
        tokens = self._qwen_aligner().align(audio, text, lang_name)
        try:
            import mlx.core as mx
            mx.clear_cache()
        except Exception:
            pass
        words = reconcile_aligned_words(units, tokens)
        if not words:
            return None
        # An all-zero answer means the model found nothing to place.
        if len(words) > 2 and words[-1]['end'] - words[0]['start'] <= 0:
            return None
        return words

    # ----------------------------------------------------------------- plan
    @staticmethod
    def _plan(text, segments, duration):
        """
        Windows to align: (text, start, end). Time-bounded segments (end >
        start) each get their own padded window; anything else aligns the whole
        file in one go, as before.
        """
        timed = []
        for seg in segments or []:
            try:
                s, e = float(seg.get('start') or 0), float(seg.get('end') or 0)
            except (TypeError, ValueError, AttributeError):
                timed = None
                break
            if not (seg.get('text') or '').strip():
                continue
            if e > s:
                timed.append(((seg.get('text') or '').strip(), s, e))
            else:
                timed = None
                break
        if timed:
            return timed, True
        return [((text or '').strip(), 0.0, duration)], False

    # ------------------------------------------------------------------ API
    def align(self, wav_path, text, language=None, progress_cb=None, segments=None):
        """
        @returns list of {word, start, end, probability}, 1:1 with the units of
        the transcript (whitespace words; Han characters individually), or None
        when nothing could be aligned. Never raises — a failure here must not
        lose an otherwise good transcript. See `last_error`.
        """
        self.last_error = None
        self.backend_used = None
        self.distributed_windows = 0
        self.fallback_windows = 0
        try:
            return self._align(wav_path, text, language, progress_cb, segments)
        except Exception as e:
            self.last_error = f'{type(e).__name__}: {e}'
            return None

    def _align(self, wav_path, text, language, progress_cb, segments):
        if not split_units(text) and not any(split_units((s or {}).get('text'))
                                             for s in segments or []):
            return []
        if not self.available():
            self.last_error = 'No forced-aligner backend is installed.'
            return None

        audio = self._load_audio(wav_path)
        duration = len(audio) / ALIGN_SAMPLE_RATE
        windows, bounded = self._plan(text, segments, duration)

        used, errors, out = set(), [], []
        failed_all = True
        for i, (wtext, t0, t1) in enumerate(windows):
            if progress_cb:
                progress_cb(0.9 + 0.09 * i / max(1, len(windows)), 'Aligning word timings…')
            units = split_units(wtext)
            if not units:
                continue
            ws = max(0.0, t0 - WINDOW_PAD_SECONDS) if bounded else 0.0
            we = min(duration, t1 + WINDOW_PAD_SECONDS) if bounded else duration
            piece = audio[int(ws * ALIGN_SAMPLE_RATE):int(we * ALIGN_SAMPLE_RATE)]
            words, backend = None, None

            if self._qwen_ready() and (we - ws) <= QWEN_ALIGNER_MAX_SECONDS:
                lang_name = self._qwen_language(language, wtext)
                if lang_name:
                    try:
                        words = self._align_qwen(piece, wtext, units, lang_name)
                        backend = 'qwen3'
                        if words is None:
                            errors.append('Qwen3 aligner output did not match the transcript')
                    except Exception as e:
                        errors.append(f'Qwen3 aligner: {type(e).__name__}: {e}')
                        if 'Failed to load' in str(e) or isinstance(e, (ImportError, OSError)):
                            self._qwen_failed = True
            if words is None and self.prefer != 'qwen3' and self._torch_ok():
                if backend == 'qwen3':
                    self.fallback_windows += 1
                try:
                    words = self._align_mms(piece, units, language, pad_with_star=bounded)
                    backend = 'mms'
                except Exception as e:
                    words = None
                    errors.append(f'MMS aligner: {type(e).__name__}: {e}')

            if words is None:
                if not bounded:
                    break              # a whole-file window has nothing to spread over
                self.distributed_windows += 1
                out.extend(_distribute_words(' '.join(units), t0, t1))
                continue
            failed_all = False
            used.add(backend)
            out.extend({**w, 'start': w['start'] + ws, 'end': w['end'] + ws} for w in words)

        if errors:
            self.last_error = errors[-1]
        if failed_all:
            return None
        self.backend_used = ('mixed' if len(used) > 1 else next(iter(used))) if used else None
        return out

    @staticmethod
    def _normalise(words, language=None):
        """MMS_FA tokens for each word: the alphabet only, '*' when nothing is left."""
        return [mms_normalise(w, language) or '*' for w in words]
