"""
Transcription model registry.

Each entry records not just "how accurate", but the three things that actually
decide whether a model is usable in a subtitling tool:

  * `engine`        — which runtime loads it. On Apple Silicon this matters more
                      than the model choice: CTranslate2 (faster-whisper) has no
                      Metal backend, so it runs on CPU cores only and leaves the
                      GPU idle. The MLX engines use the GPU.
  * `word_timings`  — whether the model itself reports per-word times.
                      The strongest current models are LLM-backbone designs that
                      emit text without reliable timings, so they need the
                      forced aligner to be usable for captions at all.
  * `languages`     — 'multilingual' or an explicit list. An English-only model
                      paired with a non-English language silently returns
                      nonsense, so the UI must not offer that combination.

WER figures are English averages from the Hugging Face Open ASR Leaderboard.
Qwen3-ASR, both Granite Speech models, Parakeet v3 and Whisper large-v3 use the
public-set means of the 21 October 2026 snapshot, as reported in Table 6 of the
Nemotron 3.5 Transcribe technical report. Parakeet v2 (6.05) and Cohere
Transcribe (5.42) are not in that table and keep the figures recorded when they
were added, from an earlier snapshot, so they are not strictly comparable. The
top of the leaderboard moves monthly and is separated by well under one WER
point, so treat them as a rough tier guide rather than a ranking to optimise
against. Entries where no figure is recorded are left as None rather than
guessed.

A model can be marked `superseded_by` a newer one. It stays resolvable through
get() so saved projects and settings keep working, and an installed copy is still
listed (flagged, so it can be removed), but it is no longer offered otherwise.
"""

import os
import platform
import shutil
import subprocess
import sys

# Engine identifiers
ENGINE_MLX_WHISPER = 'mlx-whisper'
ENGINE_MLX_PARAKEET = 'parakeet-mlx'
ENGINE_MLX_QWEN3 = 'mlx-qwen3-asr'
ENGINE_TRANSFORMERS = 'transformers'
ENGINE_GRANITE_SPEECH = 'granite-speech'
ENGINE_FASTER_WHISPER = 'faster-whisper'
ENGINE_MLX_AUDIO = 'mlx-audio'

def is_apple_silicon():
    return platform.system() == 'Darwin' and platform.machine() in ('arm64', 'aarch64')


ENGINE_LABELS = {
    ENGINE_MLX_WHISPER: 'MLX (Apple GPU)',
    ENGINE_MLX_PARAKEET: 'MLX (Apple GPU)',
    ENGINE_MLX_QWEN3: 'MLX (Apple GPU)',
    ENGINE_TRANSFORMERS: 'Transformers (MPS/CUDA/CPU)',
    ENGINE_GRANITE_SPEECH: 'Transformers (MPS/CUDA/CPU)',
    ENGINE_MLX_AUDIO: 'MLX (Apple GPU)',
    # CTranslate2 has no Metal backend, which is worth saying on a Mac and
    # actively misleading anywhere else — it is the GPU path on an NVIDIA box.
    ENGINE_FASTER_WHISPER: ('faster-whisper (CPU on Mac)' if is_apple_silicon()
                            else 'faster-whisper (CUDA/CPU)'),
}

ENGINE_PACKAGES = {
    ENGINE_MLX_WHISPER: 'mlx-whisper',
    ENGINE_MLX_PARAKEET: 'parakeet-mlx',
    ENGINE_MLX_QWEN3: 'mlx-qwen3-asr',
    ENGINE_TRANSFORMERS: 'transformers',
    ENGINE_GRANITE_SPEECH: 'transformers',
    ENGINE_FASTER_WHISPER: 'faster-whisper',
    ENGINE_MLX_AUDIO: 'mlx-audio',
}


def _m(apple=None, **kw):
    """
    One catalogue entry, resolved for this machine.

    Several models exist in two weight formats: a CTranslate2 build that
    faster-whisper runs on CPU or an NVIDIA GPU, and an MLX build that runs on
    the Apple GPU. They are the same model, so they are one entry rather than
    two near-duplicates the user has to choose between — the portable build is
    the base, and `apple` overrides it on Apple Silicon.

    Resolving here, at import, means everything downstream still sees a model
    with exactly one repo and one engine.
    """
    base = {
        'id': None,
        'repo': None,
        'label': '',
        'engine': ENGINE_FASTER_WHISPER,
        'size_gb': None,
        'languages': 'multilingual',
        'english_only': False,
        'wer': None,               # reported Open ASR Leaderboard English avg
        'word_timings': False,     # does the model itself give per-word times
        'needs_alignment': True,   # run the forced aligner for caption timing
        'notes': '',
        'tier': 'balanced',        # accuracy | balanced | fast
        'superseded_by': None,     # id of the newer model that replaces this one
        'platforms': ['any'],      # as for runtimes: restricts where it is offered
        'min_ram_gb': None,        # not offered on a machine with less memory
    }
    base.update(kw)
    if apple and is_apple_silicon():
        base.update(apple)
    return base


# The 40 languages Nemotron 3.5 Transcribe lists as supported (model card).
NEMOTRON_LANGUAGES = [
    'cs', 'nl', 'en', 'fr', 'de', 'hi', 'it', 'ko', 'pl', 'pt', 'ru', 'sk', 'es',
    'bg', 'hr', 'da', 'et', 'fi', 'hu', 'ja', 'lv', 'lt', 'ro', 'sl', 'sv', 'th',
    'tr', 'uk', 'ar', 'bn', 'zh', 'el', 'he', 'id', 'mt', 'mr', 'tl', 'ta', 'te',
    'vi',
]


MODELS = {
    # ---------------------------------------------------------------- accuracy
    'qwen3-asr-1.7b': _m(
        id='qwen3-asr-1.7b',
        # mlx-community publish this only with a precision suffix; the bare
        # 'mlx-community/Qwen3-ASR-1.7B' does not exist on the hub, so it could
        # never be installed. bf16 is the unquantised conversion.
        repo='mlx-community/Qwen3-ASR-1.7B-bf16',
        label='Qwen3-ASR 1.7B',
        engine=ENGINE_MLX_QWEN3,
        # This app runs it only through MLX (the PyTorch original would need
        # the qwen-asr package, which it does not carry), so it is hidden off
        # Apple Silicon rather than listed as permanently unavailable.
        platforms=['darwin-arm64'],
        size_gb=4.1,
        languages='multilingual',
        wer=4.94,
        word_timings=False,
        needs_alignment=True,
        tier='accuracy',
        notes=('The most accurate model here that fits any Apple Silicon Mac: '
               'second only to Nemotron on English, clearly ahead on Mandarin, '
               'and strong on noisy or accented speech. LLM-backbone, so it '
               'emits no usable word timings — the forced aligner supplies them.'),
    ),
    'cohere-transcribe-2b': _m(
        id='cohere-transcribe-2b',
        repo='CohereLabs/cohere-transcribe-03-2026',
        label='Cohere Transcribe 2B',
        engine=ENGINE_TRANSFORMERS,
        size_gb=4.2,
        languages='multilingual',
        wer=5.42,
        word_timings=False,
        needs_alignment=True,
        tier='accuracy',
        notes=('Apache 2.0. Topped the Open ASR Leaderboard for English on '
               'release (since overtaken) and is comparable or better than '
               'other open models across 13 further languages. No word '
               'timings of its own.'),
    ),
    'granite-speech-5.0-2b': _m(
        id='granite-speech-5.0-2b',
        repo='ibm-granite/granite-speech-5.0-2b',
        label='IBM Granite Speech 5.0 2B',
        engine=ENGINE_GRANITE_SPEECH,
        size_gb=4.4,
        # Speech recognition is trained for these six; the model card lists
        # more languages only for translation. An explicit list makes the UI
        # refuse the rest instead of returning guesswork.
        languages=['en', 'fr', 'de', 'es', 'pt', 'ja'],
        wer=5.06,
        word_timings=False,
        needs_alignment=True,
        tier='accuracy',
        notes=('Apache 2.0. Best English WER of the portable models here, and '
               'it runs on CUDA and CPU as well as Apple Silicon. Covers '
               'English, French, German, Spanish, Portuguese and Japanese. '
               'LLM-backbone: slower per audio-hour, and it needs the forced '
               'aligner for caption timing.'),
    ),
    'granite-speech-4.1-2b': _m(
        id='granite-speech-4.1-2b',
        repo='ibm-granite/granite-speech-4.1-2b',
        label='IBM Granite Speech 4.1 2B',
        engine=ENGINE_GRANITE_SPEECH,
        size_gb=4.4,
        languages='multilingual',
        wer=5.35,
        word_timings=False,
        needs_alignment=True,
        tier='accuracy',
        superseded_by='granite-speech-5.0-2b',
        notes=('Replaced by Granite Speech 5.0, which is more accurate at the '
               'same size. Kept here only while it is installed. LLM-backbone '
               'and needs the forced aligner for caption timing.'),
    ),

    # Nemotron 3.5 Transcribe. NVIDIA's own runtimes (NeMo, vLLM) need NVIDIA
    # datacentre or Blackwell GPUs on Linux, which this app cannot ship, so it is
    # offered only where mlx-audio runs it natively: Apple Silicon with enough
    # unified memory. The official NVIDIA NVFP4/FP8 checkpoints load directly and,
    # unlike the community "EA" MLX exports (early-access weights under an
    # evaluation licence, with no CTC head), keep the CTC timestamp head, so the
    # model gives its own word times and needs no aligner pass.
    'nemotron-3.5-transcribe': _m(
        id='nemotron-3.5-transcribe',
        repo='nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-NVFP4',
        label='NVIDIA Nemotron 3.5 Transcribe 30B (4-bit)',
        engine=ENGINE_MLX_AUDIO,
        platforms=['darwin-arm64'],
        min_ram_gb=48,
        size_gb=21.6,
        languages=NEMOTRON_LANGUAGES,
        wer=4.71,
        # NVIDIA's CTC timing head is in the checkpoint, but mlx-audio's port
        # of it misplaces words when more than one voice is present, so the
        # forced aligner supplies timings (see NemotronMlxEngine.load).
        word_timings=False,
        needs_alignment=True,
        tier='accuracy',
        notes=('The most accurate open model on the Open ASR Leaderboard, in 40 '
               'languages. Large: a 22 GB download and about 31 GB of memory '
               'while it runs (48 GB Mac or better), and slower than Qwen3-ASR. '
               'This 4-bit build can lose some accuracy outside English. Word '
               'timings come from the forced aligner. OpenMDW-1.1 licence.'),
    ),

    # ------------------------------------------------------- English specialist
    'parakeet-tdt-0.6b-v2': _m(
        id='parakeet-tdt-0.6b-v2',
        repo='mlx-community/parakeet-tdt-0.6b-v2',
        label='NVIDIA Parakeet TDT 0.6B v2',
        engine=ENGINE_MLX_PARAKEET,
        # The NeMo original needs a runtime this app does not carry, so the MLX
        # conversion is the only build it can run.
        platforms=['darwin-arm64'],
        size_gb=1.3,
        languages=['en'],
        english_only=True,
        word_timings=True,
        needs_alignment=False,
        tier='accuracy',
        wer=6.05,
        notes=('Very strong on English and by far the fastest of the accurate '
               'options on Apple Silicon — it runs on the GPU through MLX and '
               'reports its own token timings. English only.'),
    ),
    'parakeet-tdt-0.6b-v3': _m(
        id='parakeet-tdt-0.6b-v3',
        repo='mlx-community/parakeet-tdt-0.6b-v3',
        label='NVIDIA Parakeet TDT 0.6B v3',
        engine=ENGINE_MLX_PARAKEET,
        platforms=['darwin-arm64'],
        size_gb=1.3,
        # The 25 European languages it was trained on. It detects which one it
        # is hearing by itself and takes no language argument, so a language
        # outside this list is refused up front rather than transliterated.
        languages=['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de',
                   'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk',
                   'sl', 'es', 'sv', 'ru', 'uk'],
        word_timings=True,
        needs_alignment=False,
        tier='accuracy',
        wer=5.58,
        notes=('Parakeet v2\'s multilingual successor: 25 European languages with '
               'its own word timings, at the same speed on the Apple GPU. A '
               'fraction behind v2 on English alone.'),
    ),

    # ------------------------------------------------------------ whisper family
    # The Whisper family ships in both formats, so these run everywhere: MLX on
    # the Apple GPU, CTranslate2 on CPU or an NVIDIA GPU. Both report word
    # timings natively, so needs_alignment stays False either way.
    'whisper-large-v3': _m(
        id='whisper-large-v3',
        repo='Systran/faster-whisper-large-v3',
        label='Whisper large-v3',
        engine=ENGINE_FASTER_WHISPER,
        apple=dict(repo='mlx-community/whisper-large-v3-mlx',
                   engine=ENGINE_MLX_WHISPER),
        size_gb=3.1,
        languages='multilingual',
        wer=6.66,
        word_timings=True,
        needs_alignment=False,
        tier='balanced',
        notes=('The long-standing multilingual baseline. Now well behind the '
               'accuracy tier above, but it reports word timings natively and '
               'handles 99 languages.'),
    ),
    'whisper-large-v3-turbo': _m(
        id='whisper-large-v3-turbo',
        # Systran publish no turbo build; this is the CTranslate2 conversion in
        # general use.
        repo='deepdml/faster-whisper-large-v3-turbo-ct2',
        label='Whisper large-v3-turbo',
        engine=ENGINE_FASTER_WHISPER,
        apple=dict(repo='mlx-community/whisper-large-v3-turbo',
                   engine=ENGINE_MLX_WHISPER),
        size_gb=1.6,
        languages='multilingual',
        word_timings=True,
        needs_alignment=False,
        tier='balanced',
        notes=('Distilled decoder: close to large-v3 quality for transcription '
               'at roughly 8x the speed. Weaker at the translate task. A good '
               'default when you want multilingual output quickly.'),
    ),
    'whisper-medium': _m(
        id='whisper-medium', repo='Systran/faster-whisper-medium',
        label='Whisper medium', engine=ENGINE_FASTER_WHISPER, size_gb=1.5,
        apple=dict(repo='mlx-community/whisper-medium-mlx',
                   engine=ENGINE_MLX_WHISPER),
        word_timings=True, needs_alignment=False, tier='balanced',
        notes='Mid-size multilingual Whisper.',
    ),
    'whisper-small': _m(
        id='whisper-small', repo='Systran/faster-whisper-small',
        label='Whisper small', engine=ENGINE_FASTER_WHISPER, size_gb=0.5,
        apple=dict(repo='mlx-community/whisper-small-mlx',
                   engine=ENGINE_MLX_WHISPER),
        word_timings=True, needs_alignment=False, tier='fast',
        notes='Small multilingual Whisper. Quick, noticeably less accurate.',
    ),
    'whisper-tiny': _m(
        id='whisper-tiny', repo='Systran/faster-whisper-tiny',
        label='Whisper tiny', engine=ENGINE_FASTER_WHISPER, size_gb=0.08,
        apple=dict(repo='mlx-community/whisper-tiny-mlx',
                   engine=ENGINE_MLX_WHISPER),
        word_timings=True, needs_alignment=False, tier='fast',
        notes='Fastest, lowest accuracy. Useful for a rough first pass.',
    ),
    'distil-large-v3': _m(
        id='distil-large-v3',
        repo='distil-whisper/distil-large-v3',
        label='Distil-Whisper large-v3',
        engine=ENGINE_TRANSFORMERS,
        size_gb=1.5,
        languages=['en'],
        english_only=True,
        word_timings=True,
        needs_alignment=False,
        tier='fast',
        notes='English only. Fast, but Parakeet is both faster and more accurate on Apple Silicon.',
    ),
}

# The forced aligners. Two backends attach precise word times to a transcript,
# whatever produced it; engines.ForcedAligner picks per window of audio.
#
#   * Qwen3-ForcedAligner (Apple Silicon, MLX): the preferred backend. 11
#     languages (Chinese, English, Cantonese, French, German, Italian, Japanese,
#     Korean, Portuguese, Russian, Spanish), up to 5 minutes of speech per call,
#     per the model card. Its weights are a normal Hugging Face repo, installed
#     explicitly from Settings and never downloaded behind the user's back.
#   * MMS_FA (torchaudio, every platform): CTC alignment over 1000+ languages
#     via romanised text. Its weights are not on the Hugging Face hub at all:
#     torchaudio fetches them from dl.fbaipublicfiles.com into the torch hub
#     cache (~/.cache/torch/hub/checkpoints/model.pt) on first use, so this
#     entry has no `repo`; `source` tells the installer how to fetch it.
SOURCE_TORCHAUDIO_MMS = 'torchaudio-mms'

QWEN_ALIGNER_MODEL = {
    'id': 'qwen3-forced-aligner',
    'repo': 'Qwen/Qwen3-ForcedAligner-0.6B',
    'label': 'Qwen3 Forced Aligner (word timing)',
    'size_gb': 1.7,
    'platforms': ['darwin-arm64'],
    'notes': ('Runs on the Apple GPU and places each word to within a frame or two. '
              'Covers Chinese, English, Cantonese, French, German, Italian, Japanese, '
              'Korean, Portuguese, Russian and Spanish, up to five minutes of speech '
              'at a time; anything else uses the MMS aligner instead. Needs the '
              'Qwen3-ASR MLX runtime. Recommended for captions.'),
}

MMS_ALIGNER_MODEL = {
    'id': 'mms-fa-aligner',
    'repo': None,
    'source': SOURCE_TORCHAUDIO_MMS,
    'label': 'MMS Forced Aligner (word timing)',
    'size_gb': 1.3,
    'platforms': ['any'],
    'notes': ('Multilingual CTC aligner covering 1000+ languages, run through '
              'PyTorch on any platform. The weights come from torchaudio rather '
              'than Hugging Face and download to the PyTorch cache. Supplies '
              'word times for models that report none, and is the fallback where '
              'the Qwen3 aligner does not apply.'),
}

# What Settings shows as "the aligner": the best one this machine can run.
ALIGNER_MODEL = QWEN_ALIGNER_MODEL if is_apple_silicon() else MMS_ALIGNER_MODEL
ALIGNER_MODELS = [QWEN_ALIGNER_MODEL, MMS_ALIGNER_MODEL] if is_apple_silicon() else [MMS_ALIGNER_MODEL]

# Speaker separation. ECAPA-TDNN turns a passage of speech into a vector that
# describes the voice rather than the words, which is what lets the same person
# be recognised across a whole timeline. Small, and ungated — unlike pyannote's
# diarisation weights, which need a licence acceptance and an access token.
DIARIZER_MODEL = {
    'id': 'ecapa-speaker-embeddings',
    'repo': 'speechbrain/spkrec-ecapa-voxceleb',
    'label': 'ECAPA Speaker Embeddings (speaker separation)',
    'size_gb': 0.08,
    'notes': ('Identifies who is speaking, so captions break at every change of '
              'voice and never put two people on one line. Needs word timings, '
              'so it pairs with the aligner.'),
}

# Models that are not transcription engines but still install and remove like
# one from the Settings panel.
EXTRA_MODELS = {m['id']: m for m in (*ALIGNER_MODELS, DIARIZER_MODEL)}


def _torch_stack_mb():
    """
    Rough on-disk cost of the torch runtimes, which is not the same everywhere.

    PyPI's default torch wheel for Linux is the CUDA build and drags in the
    nvidia-* packages with it — around 3 GB whether or not the machine has an
    NVIDIA card. Windows and macOS get CPU and MPS builds respectively, which
    are a fraction of that. Quoting one flat figure understates Linux badly
    enough that the disk-space check would pass and the install would then fail.
    """
    if is_apple_silicon() or platform.system() == 'Darwin':
        return 2500
    if os.name == 'nt':
        return 900
    return 3600


TORCH_STACK_MB = _torch_stack_mb()


def has_nvidia():
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Optional runtimes, installable into the app's own venv from Settings
# ---------------------------------------------------------------------------
#
# Each entry is a pip-installable runtime plus the module that proves it landed.
# `platforms` restricts what is offered: the MLX runtimes only exist for Apple
# Silicon, so showing them elsewhere would just produce install failures.

RUNTIMES = {
    ENGINE_MLX_WHISPER: {
        'id': ENGINE_MLX_WHISPER,
        'label': 'MLX Whisper (Apple GPU)',
        'packages': ['mlx-whisper>=0.4.0'],
        'module': 'mlx_whisper',
        'platforms': ['darwin-arm64'],
        'size_mb': 90,
        'notes': 'Runs the Whisper family on the Apple GPU instead of the CPU.',
    },
    ENGINE_MLX_PARAKEET: {
        'id': ENGINE_MLX_PARAKEET,
        'label': 'Parakeet MLX (Apple GPU)',
        'packages': ['parakeet-mlx>=0.3.0'],
        'module': 'parakeet_mlx',
        'platforms': ['darwin-arm64'],
        'size_mb': 90,
        'notes': 'Fastest accurate English option on Apple Silicon.',
    },
    ENGINE_MLX_QWEN3: {
        'id': ENGINE_MLX_QWEN3,
        'label': 'Qwen3-ASR MLX (Apple GPU)',
        'packages': ['mlx-qwen3-asr>=0.4.4'],
        'module': 'mlx_qwen3_asr',
        'platforms': ['darwin-arm64'],
        'size_mb': 90,
        'notes': ('Strongest multilingual accuracy, on the Apple GPU. Also runs the '
                  'Qwen3 forced aligner, the most precise word-timing option on '
                  'Apple Silicon.'),
    },
    ENGINE_TRANSFORMERS: {
        'id': ENGINE_TRANSFORMERS,
        'label': 'Transformers + PyTorch',
        'packages': ['transformers>=4.40.0', 'torch>=2.2.0', 'torchaudio>=2.2.0'],
        'module': 'transformers',
        'platforms': ['any'],
        'size_mb': TORCH_STACK_MB,
        'notes': ('Needed for Cohere Transcribe, and it also provides the '
                  'word-timing aligner. Large download.'),
    },
    ENGINE_GRANITE_SPEECH: {
        'id': ENGINE_GRANITE_SPEECH,
        'label': 'Transformers + PyTorch (Granite Speech)',
        'packages': ['transformers>=4.52.1', 'torch>=2.2.0', 'torchaudio>=2.2.0'],
        'module': 'transformers',
        'platforms': ['any'],
        'size_mb': TORCH_STACK_MB,
        'notes': ('Same underlying packages as Transformers + PyTorch, pinned to '
                  'a newer transformers release — Granite Speech\'s processor '
                  'classes only exist from 4.52.1 onward. Already satisfied if '
                  'that runtime is installed and current.'),
    },
    ENGINE_MLX_AUDIO: {
        'id': ENGINE_MLX_AUDIO,
        'label': 'MLX Audio (Apple GPU, Nemotron Transcribe)',
        'packages': ['mlx-audio>=0.6.5'],
        'module': 'mlx_audio',
        'platforms': ['darwin-arm64'],
        # mlx-audio itself is small; it pulls in transformers, sentencepiece,
        # scipy, miniaudio and sounddevice (mlx and numpy are already present).
        # No torch.
        'size_mb': 120,
        'notes': ('Runs NVIDIA Nemotron 3.5 Transcribe on the Apple GPU. A small '
                  'download; the model itself is large.'),
    },
    ENGINE_FASTER_WHISPER: {
        'id': ENGINE_FASTER_WHISPER,
        'label': 'faster-whisper (CTranslate2)',
        'packages': ['faster-whisper>=1.0.0'],
        'module': 'faster_whisper',
        'platforms': ['any'],
        'size_mb': 150,
        'notes': ('For NVIDIA GPUs and generic CPU. No Metal backend, so on '
                  'Apple Silicon this stays on the CPU.'),
    },
    'demucs': {
        'id': 'demucs',
        'label': 'Demucs (music suppression)',
        'packages': ['demucs>=4.0.0', 'torch>=2.2.0', 'torchaudio>=2.2.0'],
        'module': 'demucs',
        'platforms': ['any'],
        'size_mb': TORCH_STACK_MB,
        'notes': ('Isolates the dialogue from a music bed before transcribing. The '
                  'single biggest accuracy gain on advertising and promo material, '
                  'at the cost of a slow extra pass.'),
    },
    'diarizer-speechbrain': {
        'id': 'diarizer-speechbrain',
        'label': 'SpeechBrain (speaker separation)',
        'packages': ['speechbrain>=1.0.0', 'torch>=2.2.0', 'torchaudio>=2.2.0'],
        'module': 'speechbrain',
        'platforms': ['any'],
        'size_mb': TORCH_STACK_MB,
        'notes': ('Works out who is speaking, so each caption holds one voice and '
                  'carries their name. Shares torch with the aligner, so on top of '
                  'that runtime it is a small extra download.'),
    },
    'aligner-torch': {
        'id': 'aligner-torch',
        'label': 'PyTorch + torchaudio (word-timing aligner)',
        'packages': ['torch>=2.2.0', 'torchaudio>=2.2.0', 'uroman>=1.3', 'num2words>=0.5.14'],
        'module': 'torchaudio',
        'platforms': ['any'],
        'size_mb': TORCH_STACK_MB,
        'notes': ('Powers the MMS forced aligner, which measures per-word times '
                  'instead of inferring them and covers 1000+ languages. uroman and '
                  'num2words let it handle digits and non-Latin scripts. Strongly '
                  'recommended for captions.'),
    },
}


def platform_tag():
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == 'darwin' and machine in ('arm64', 'aarch64'):
        return 'darwin-arm64'
    return f'{system}-{machine}'


def runtime_supported(runtime):
    plats = runtime.get('platforms') or ['any']
    return 'any' in plats or platform_tag() in plats


def module_available(module_name):
    try:
        __import__(module_name)
        return True
    except Exception:
        return False


def runtime_outdated(runtime):
    """
    Whether an installed runtime falls short of its own package list.

    "Installed" only proves the module imports, so a runtime installed by an
    earlier release stays "installed" forever even when this release needs a
    newer version of it, or an extra package alongside it (the aligner's
    uroman and num2words). Comparing against the requirement strings lets
    Settings offer an update, which is the same pip install: pip upgrades
    anything whose minimum is not met.

    Never raises; if the versions cannot be read, the runtime is reported
    current rather than nagging about something that may be fine.
    """
    try:
        from importlib import metadata
        from packaging.requirements import Requirement
    except Exception:
        return False
    for spec in runtime.get('packages') or []:
        try:
            req = Requirement(spec)
            try:
                have = metadata.version(req.name)
            except metadata.PackageNotFoundError:
                return True
            if req.specifier and not req.specifier.contains(have, prereleases=True):
                return True
        except Exception:
            continue
    return False


def list_runtimes():
    """Installable runtimes for this machine, with live installed state."""
    out = []
    for rt in RUNTIMES.values():
        if not runtime_supported(rt):
            continue
        installed = module_available(rt['module'])
        out.append(dict(rt,
                        installed=installed,
                        outdated=installed and runtime_outdated(rt),
                        recommended=rt['id'] in recommended_runtimes()))
    return out


def recommended_runtimes():
    """
    The set worth having on this machine.

    On Apple Silicon that means the GPU runtimes — faster-whisper would work but
    would leave the GPU idle — plus mlx-qwen3-asr, which runs the Qwen3 forced
    aligner, and torch for the MMS aligner that covers every other language;
    without either, the accuracy-tier models cannot produce caption timings.
    """
    if is_apple_silicon():
        return [ENGINE_MLX_WHISPER, ENGINE_MLX_PARAKEET, ENGINE_MLX_QWEN3, 'aligner-torch']
    return [ENGINE_FASTER_WHISPER, 'aligner-torch']


def get_runtime(runtime_id):
    return RUNTIMES.get(runtime_id)


def engine_available(engine):
    """Whether the runtime package for an engine is importable."""
    module = {
        ENGINE_MLX_WHISPER: 'mlx_whisper',
        ENGINE_MLX_PARAKEET: 'parakeet_mlx',
        ENGINE_MLX_QWEN3: 'mlx_qwen3_asr',
        ENGINE_TRANSFORMERS: 'transformers',
        ENGINE_GRANITE_SPEECH: 'transformers',
        ENGINE_FASTER_WHISPER: 'faster_whisper',
        ENGINE_MLX_AUDIO: 'mlx_audio',
    }.get(engine)
    if not module:
        return False
    try:
        __import__(module)
        return True
    except Exception:
        return False


def hf_cache_dir():
    return os.environ.get('HF_HOME') or os.path.join(
        os.path.expanduser('~'), '.cache', 'huggingface')


def repo_cache_path(repo):
    """Where huggingface_hub would place this repo's snapshot."""
    if not repo:
        return None
    folder = 'models--' + repo.replace('/', '--')
    return os.path.join(hf_cache_dir(), 'hub', folder)


def is_installed(repo):
    path = repo_cache_path(repo)
    if not path or not os.path.isdir(path):
        return False
    snapshots = os.path.join(path, 'snapshots')
    if not os.path.isdir(snapshots):
        return False
    # A snapshot directory containing at least one real file means it landed.
    for root, _dirs, files in os.walk(snapshots):
        if files:
            return True
    return False


def torch_hub_checkpoint_path():
    """Where torchaudio's MMS_FA weights land (torch.hub's checkpoint cache)."""
    home = os.environ.get('TORCH_HOME') or os.path.join(
        os.environ.get('XDG_CACHE_HOME') or os.path.join(os.path.expanduser('~'), '.cache'),
        'torch')
    return os.path.join(home, 'hub', 'checkpoints', 'model.pt')


def entry_cache_path(entry):
    """Cache location of a catalogue entry, whichever source it comes from."""
    if entry.get('source') == SOURCE_TORCHAUDIO_MMS:
        return torch_hub_checkpoint_path()
    return repo_cache_path(entry.get('repo'))


def entry_installed(entry):
    """Like is_installed(), but also understands entries fetched by torchaudio."""
    if entry.get('source') == SOURCE_TORCHAUDIO_MMS:
        path = torch_hub_checkpoint_path()
        try:
            return os.path.isfile(path) and os.path.getsize(path) > 100 * 1024 * 1024
        except OSError:
            return False
    return is_installed(entry.get('repo'))


def dir_size_bytes(path):
    if not path or not os.path.isdir(path):
        return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            try:
                # follow_symlinks=False: the blob is counted once, not per link
                total += os.stat(fp, follow_symlinks=False).st_size
            except OSError:
                pass
    return total


def describe(model):
    """Registry entry plus live install state."""
    out = dict(model)
    out['installed'] = entry_installed(model)
    out['engine_label'] = ENGINE_LABELS.get(model['engine'], model['engine'])
    out['engine_package'] = ENGINE_PACKAGES.get(model['engine'], model['engine'])
    out['engine_available'] = engine_available(model['engine'])
    out['disk_bytes'] = dir_size_bytes(entry_cache_path(model)) if out['installed'] else 0
    return out


def describe_extra(entry):
    """An aligner/diarizer entry with live install state (no engine fields)."""
    out = dict(entry)
    out['installed'] = entry_installed(entry)
    path = entry_cache_path(entry)
    if not out['installed'] or not path:
        out['disk_bytes'] = 0
    elif os.path.isfile(path):
        out['disk_bytes'] = os.path.getsize(path)
    else:
        out['disk_bytes'] = dir_size_bytes(path)
    return out


def list_models():
    """
    The models this machine can actually run.

    A model whose only published weights need a runtime this platform cannot
    install would sit in the list permanently unavailable, with the runtime that
    would fix it correctly hidden from Settings — a dead end. Better not to
    offer it. get() still resolves any id, so a project made on another machine
    still opens. Superseded models are listed only while installed.
    """
    out = []
    for m in MODELS.values():
        if not model_supported(m):
            continue
        d = describe(m)
        if m.get('superseded_by'):
            # Hidden once gone, but an installed copy must stay visible so it
            # can be removed. Flag it for the UI and say so in the label.
            if not d['installed']:
                continue
            d['superseded'] = True
            newer = MODELS.get(m['superseded_by'])
            d['label'] = f"{m['label']} (superseded"
            d['label'] += f" by {newer['label']})" if newer else ')'
        out.append(d)
    return out


_RAM_GB = None


def total_ram_gb():
    """Installed physical memory in GB (0 if it cannot be read). Cached."""
    global _RAM_GB
    if _RAM_GB is None:
        total = 0
        try:
            if sys.platform == 'darwin':
                out = subprocess.run(['sysctl', '-n', 'hw.memsize'],
                                     capture_output=True, text=True, timeout=5)
                total = int(out.stdout.strip() or 0)
            else:
                total = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
        except Exception:
            total = 0
        _RAM_GB = round(total / (1024 ** 3), 1)
    return _RAM_GB


def model_supported(model):
    plats = model.get('platforms') or ['any']
    if not ('any' in plats or platform_tag() in plats):
        return False
    need = model.get('min_ram_gb')
    # An unreadable total (0) must not hide a model that is probably fine.
    if need and total_ram_gb() and total_ram_gb() < need:
        return False
    return True


def get(model_id):
    return MODELS.get(model_id)


def recommended(purpose='accuracy'):
    """
    Platform-aware suggestion.

    On Apple Silicon the MLX engines run on the GPU while faster-whisper is
    stuck on CPU, so the recommendation differs from a CUDA box.
    """
    # Never name a model this machine cannot run: Parakeet and Qwen3-ASR run
    # here only through MLX, so off Apple Silicon the recommendation
    # falls back to the best portable model for the same purpose.
    if purpose == 'fast':
        return 'parakeet-tdt-0.6b-v2' if is_apple_silicon() else 'whisper-large-v3-turbo'
    if purpose == 'multilingual':
        return 'qwen3-asr-1.7b' if is_apple_silicon() else 'cohere-transcribe-2b'
    if purpose == 'english':
        return 'parakeet-tdt-0.6b-v2' if is_apple_silicon() else 'distil-large-v3'
    # Best portable English WER; Cohere stays the multilingual pick above for
    # its wider language coverage.
    return 'qwen3-asr-1.7b' if is_apple_silicon() else 'granite-speech-5.0-2b'


def free_disk_bytes():
    try:
        return shutil.disk_usage(hf_cache_dir() if os.path.isdir(hf_cache_dir())
                                 else os.path.expanduser('~')).free
    except Exception:
        return 0
