"""
Local AI transcription backend for Taylor's Transcriber.

Runs open-source speech models entirely on this machine — nothing is uploaded
anywhere. Models come from the Hugging Face Hub (cached under ~/.cache/hugging-
face) or from a local directory you point at.

Two ideas shape this module:

  1. Engine choice is platform-dependent. On Apple Silicon, CTranslate2
     (faster-whisper) has no Metal backend and runs on CPU cores only, so the
     MLX engines — which use the GPU — are preferred there. See engines.py.

  2. Recognition and timing are separate passes. The most accurate models
     available are LLM-backbone designs that return text with no usable word
     times. Rather than excluding them, a CTC forced-alignment pass attaches
     precise per-word times to whatever transcript comes back. That also
     tightens Whisper's own timings, which are inferred from cross-attention
     and drift noticeably.

Audio arrives from the front-end already decoded to 16 kHz mono WAV, so no
ffmpeg is needed for transcription.
"""

import os
import base64
import shutil
import tempfile
import threading
import traceback
import uuid

import audio_tools
import bootstrap
import diarize
import model_registry as registry
import engines as engines_mod
import vocabulary as vocab
import version

TERMINAL_STATES = ('done', 'error', 'cancelled')

# Below this, a word is worth an operator's eye. Whisper-family probabilities
# cluster high, so the threshold sits well above a coin flip.
LOW_CONFIDENCE = 0.62


class TranscriptionJob:
    def __init__(self, job_id, options):
        self.id = job_id
        self.options = options or {}
        # receiving -> separating -> loading -> transcribing -> aligning
        #   -> diarizing -> done
        self.state = 'receiving'
        self.progress = 0.0
        self.message = 'Waiting for audio…'
        self.error = None
        self.result = None
        self.cancelled = False
        self.audio_path = None
        self.audio_file = None
        self.bytes_received = 0
        self.thread = None
        self.notes = []

    def snapshot(self):
        return {
            'ok': True,
            'job_id': self.id,
            'state': self.state,
            'progress': round(self.progress, 4),
            'message': self.message,
            'error': self.error,
            'result': self.result if self.state == 'done' else None,
            'bytes_received': self.bytes_received,
        }


class InstallJob:
    def __init__(self, job_id, model_id, repo):
        self.id = job_id
        self.model_id = model_id
        self.repo = repo
        self.state = 'downloading'
        self.progress = 0.0
        self.message = 'Starting download…'
        self.error = None
        self.cancelled = False
        self.downloaded = 0
        self.total = 0

    def snapshot(self):
        return {
            'ok': True, 'job_id': self.id, 'model_id': self.model_id,
            'state': self.state, 'progress': round(self.progress, 4),
            'message': self.message, 'error': self.error,
            'downloaded': self.downloaded, 'total': self.total,
        }


class RuntimeInstallJob:
    def __init__(self, job_id, runtime_id, label):
        self.id = job_id
        self.runtime_id = runtime_id
        self.label = label
        self.state = 'installing'
        self.message = f'Installing {label}…'
        self.error = None
        self.lines = []

    def snapshot(self):
        return {
            'ok': True, 'job_id': self.id, 'runtime_id': self.runtime_id,
            'state': self.state, 'message': self.message, 'error': self.error,
            'lines': self.lines[-6:],
        }


class Transcriber:
    def __init__(self):
        self.jobs = {}
        self.installs = {}
        self.runtime_jobs = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Capability probing
    # ------------------------------------------------------------------
    def probe(self):
        available_engines = [e for e in registry.ENGINE_LABELS if registry.engine_available(e)]

        device, device_name = 'cpu', 'CPU'
        if registry.is_apple_silicon():
            device, device_name = 'mps', 'Apple Silicon GPU'
        try:
            import torch
            if torch.cuda.is_available():
                device, device_name = 'cuda', torch.cuda.get_device_name(0)
        except Exception:
            pass

        models = registry.list_models()
        installed = [m for m in models if m['installed']]
        aligner_installed = registry.is_installed(registry.ALIGNER_MODEL['repo'])

        return {
            'ok': True,
            'version': version.__version__,
            'bundled': bootstrap.is_bundled(),
            'available': len(available_engines) > 0,
            'engines': available_engines,
            'engine_labels': registry.ENGINE_LABELS,
            'device': device,
            'device_name': device_name,
            'apple_silicon': registry.is_apple_silicon(),
            'models': models,
            'installed_count': len(installed),
            'aligner': dict(registry.ALIGNER_MODEL,
                            installed=aligner_installed,
                            available=engines_mod.ForcedAligner().available()),
            'diarizer': diarize.describe(),
            'recommended': registry.recommended('accuracy'),
            'free_disk': registry.free_disk_bytes(),
            'cache_dir': registry.hf_cache_dir(),
            'runtimes': registry.list_runtimes(),
            'can_install_runtimes': bootstrap.can_install_runtimes(),
            'venv_dir': bootstrap.VENV_DIR,
            'in_venv': bootstrap.in_project_venv(),
        }

    def list_models(self):
        return {'ok': True, 'models': registry.list_models(),
                'aligner': dict(registry.ALIGNER_MODEL,
                                installed=registry.is_installed(registry.ALIGNER_MODEL['repo'])),
                'diarizer': diarize.describe()}

    # ------------------------------------------------------------------
    # Model install / removal
    # ------------------------------------------------------------------
    def install_model(self, model_id):
        """Download a model in the background; poll with install_status()."""
        try:
            extra = registry.EXTRA_MODELS.get(model_id)
            if extra:
                repo, label = extra['repo'], extra['label']
            else:
                model = registry.get(model_id)
                if not model:
                    return {'ok': False, 'error': f'Unknown model "{model_id}".'}
                repo, label = model['repo'], model['label']

            try:
                import huggingface_hub  # noqa: F401
            except ImportError:
                return {'ok': False,
                        'error': ('huggingface-hub is missing from the app environment. '
                                  'Relaunch with run_subtitler.sh to repair it.')}

            job_id = uuid.uuid4().hex
            job = InstallJob(job_id, model_id, repo)
            job.message = f'Downloading {label}…'
            with self._lock:
                self.installs[job_id] = job

            t = threading.Thread(target=self._run_install, args=(job,), daemon=True)
            t.start()
            return {'ok': True, 'job_id': job_id}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def _run_install(self, job):
        try:
            from huggingface_hub import snapshot_download
            from tqdm.auto import tqdm as base_tqdm

            outer = job

            class ProgressTqdm(base_tqdm):
                """Feeds hub download progress back to the polling UI."""
                def update(self, n=1):
                    result = super().update(n)
                    try:
                        if self.total:
                            outer.total = max(outer.total, int(self.total))
                            outer.downloaded = int(self.n)
                            outer.progress = min(0.99, float(self.n) / float(self.total))
                            mb = outer.downloaded / (1024 * 1024)
                            total_mb = outer.total / (1024 * 1024)
                            outer.message = f'Downloading… {mb:.0f} / {total_mb:.0f} MB'
                    except Exception:
                        pass
                    return result

            snapshot_download(repo_id=job.repo, tqdm_class=ProgressTqdm)

            if job.cancelled:
                job.state = 'cancelled'
                job.message = 'Cancelled.'
                return
            job.progress = 1.0
            job.state = 'done'
            job.message = 'Installed.'
        except Exception as e:
            job.state = 'error'
            job.error = str(e)
            job.message = f'Download failed: {e}'

    def install_status(self, job_id):
        job = self.installs.get(job_id)
        if not job:
            return {'ok': False, 'error': 'Unknown install job.'}
        return job.snapshot()

    def cancel_install(self, job_id):
        job = self.installs.get(job_id)
        if not job:
            return {'ok': False, 'error': 'Unknown install job.'}
        job.cancelled = True
        return {'ok': True}

    def remove_model(self, model_id):
        try:
            extra = registry.EXTRA_MODELS.get(model_id)
            if extra:
                repo = extra['repo']
            else:
                model = registry.get(model_id)
                if not model:
                    return {'ok': False, 'error': f'Unknown model "{model_id}".'}
                repo = model['repo']

            path = registry.repo_cache_path(repo)
            if not path or not os.path.isdir(path):
                return {'ok': False, 'error': 'That model is not installed.'}
            freed = registry.dir_size_bytes(path)
            shutil.rmtree(path, ignore_errors=True)
            return {'ok': True, 'freed': freed}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    # ------------------------------------------------------------------
    # Optional runtime installation (into the app's own venv)
    # ------------------------------------------------------------------
    def list_runtimes(self):
        return {'ok': True, 'runtimes': registry.list_runtimes(),
                'can_install': bootstrap.can_install_runtimes(),
                'recommended': registry.recommended_runtimes()}

    def install_runtime(self, runtime_id):
        try:
            if not bootstrap.can_install_runtimes():
                return {'ok': False,
                        'error': ('Runtimes can only be installed when the app is running in '
                                  'its own virtual environment. Relaunch with run_subtitler.sh.')}

            if runtime_id == '__recommended__':
                ids = registry.recommended_runtimes()
                pending = [i for i in ids
                           if not registry.module_available(registry.RUNTIMES[i]['module'])]
                if not pending:
                    return {'ok': False, 'error': 'Everything recommended is already installed.'}
                packages = []
                for i in pending:
                    packages += registry.RUNTIMES[i]['packages']
                label = 'recommended runtimes'
            else:
                runtime = registry.get_runtime(runtime_id)
                if not runtime:
                    return {'ok': False, 'error': f'Unknown runtime "{runtime_id}".'}
                if not registry.runtime_supported(runtime):
                    return {'ok': False,
                            'error': f'{runtime["label"]} is not available for {registry.platform_tag()}.'}
                packages = runtime['packages']
                label = runtime['label']

            job_id = uuid.uuid4().hex
            job = RuntimeInstallJob(job_id, runtime_id, label)
            with self._lock:
                self.runtime_jobs[job_id] = job

            t = threading.Thread(target=self._run_runtime_install,
                                 args=(job, packages), daemon=True)
            t.start()
            return {'ok': True, 'job_id': job_id}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def _run_runtime_install(self, job, packages):
        try:
            def on_line(line):
                job.lines.append(line)
                del job.lines[:-40]
                # pip's own wording is the most informative progress we have.
                if line.startswith(('Collecting', 'Downloading', 'Installing',
                                    'Using cached', 'Building')):
                    job.message = line[:120]

            ok, tail = bootstrap.install_packages_streaming(packages, on_line=on_line)
            if ok:
                job.state = 'done'
                job.message = f'{job.label} installed. Restart to pick it up.'
            else:
                job.state = 'error'
                job.error = 'pip install failed:\n' + '\n'.join(tail[-6:])
                job.message = 'Install failed.'
        except Exception as e:
            job.state = 'error'
            job.error = str(e)
            job.message = 'Install failed.'

    def runtime_install_status(self, job_id):
        job = self.runtime_jobs.get(job_id)
        if not job:
            return {'ok': False, 'error': 'Unknown runtime install job.'}
        return job.snapshot()

    # ------------------------------------------------------------------
    # Audio upload
    # ------------------------------------------------------------------
    def begin(self, options):
        try:
            options = options or {}
            model_id = options.get('model')
            custom = (options.get('custom_model') or '').strip()

            if not custom:
                model = registry.get(model_id)
                if not model:
                    return {'ok': False, 'error': f'Unknown model "{model_id}".'}
                if not registry.engine_available(model['engine']):
                    pkg = registry.ENGINE_PACKAGES.get(model['engine'], model['engine'])
                    return {'ok': False,
                            'error': (f'{model["label"]} needs the "{pkg}" runtime, which is not '
                                      'installed.\n\nInstall it from Settings \u2192 Speech Runtimes, '
                                      'then restart the app.'),
                            'needs_runtime': model['engine']}
                if not registry.is_installed(model['repo']):
                    return {'ok': False,
                            'error': (f'{model["label"]} has not been downloaded yet. '
                                      'Open Settings and install it first.'),
                            'needs_install': model_id}

            job_id = uuid.uuid4().hex
            job = TranscriptionJob(job_id, options)
            fd, path = tempfile.mkstemp(prefix=f'subtitler_audio_{job_id}_', suffix='.wav')
            os.close(fd)
            job.audio_path = path
            job.audio_file = open(path, 'wb')

            with self._lock:
                self.jobs[job_id] = job
            return {'ok': True, 'job_id': job_id}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def push_audio(self, job_id, b64_chunk):
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown transcription job.'}
            if job.cancelled:
                return {'ok': False, 'error': 'Cancelled.'}
            data = base64.b64decode(b64_chunk)
            job.audio_file.write(data)
            job.bytes_received += len(data)
            return {'ok': True, 'bytes_received': job.bytes_received}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def finish_audio_and_run(self, job_id):
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown transcription job.'}
            if job.audio_file:
                job.audio_file.close()
                job.audio_file = None
            if job.bytes_received == 0:
                job.state = 'error'
                job.error = 'No audio was received.'
                return {'ok': False, 'error': job.error}

            job.state = 'loading'
            job.message = 'Loading model…'
            job.thread = threading.Thread(target=self._run_job, args=(job,), daemon=True)
            job.thread.start()
            return {'ok': True, 'job_id': job_id}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def status(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return {'ok': False, 'error': 'Unknown transcription job.'}
        return job.snapshot()

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return {'ok': False, 'error': 'Unknown transcription job.'}
        job.cancelled = True
        if job.state not in TERMINAL_STATES:
            job.state = 'cancelled'
            job.message = 'Cancelled.'
        return {'ok': True}

    def cleanup(self, job_id):
        try:
            with self._lock:
                job = self.jobs.pop(job_id, None)
            if job:
                job.cancelled = True
                if job.audio_file:
                    try:
                        job.audio_file.close()
                    except Exception:
                        pass
                if job.audio_path and os.path.exists(job.audio_path):
                    os.unlink(job.audio_path)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    # ------------------------------------------------------------------
    # Worker
    # ------------------------------------------------------------------
    def _diarize(self, job, words, opts, report):
        """
        Label each word with its speaker, in place.

        Returns the speaker turns, or [] when separation could not run — which
        is never fatal: unlabelled captions still beat no captions, so the job
        carries on with a note explaining what is missing.
        """
        if not diarize.available():
            job.notes.append(
                'Speaker separation was requested but the SpeechBrain runtime is not '
                'installed, so every caption is unlabelled. Install it from '
                'Settings → Speech Runtimes.')
            return []
        if not diarize.model_installed():
            job.notes.append(
                'Speaker separation was requested but the speaker model has not been '
                'downloaded, so every caption is unlabelled. Install it from Settings.')
            return []

        result = diarize.diarize_words(job.audio_path, words,
                                       speakers=opts.get('speakers', 'auto'),
                                       progress_cb=report)
        if not result:
            job.notes.append('Speaker separation could not run on this audio, so every '
                             'caption is unlabelled.')
            return []

        turns = result.get('turns') or []
        count = result.get('count') or 0
        job.notes.append(f'Separated {count} speaker(s) across {len(turns)} turn(s).')
        return turns

    def _run_job(self, job):
        try:
            opts = job.options
            custom = (opts.get('custom_model') or '').strip()

            if custom:
                # An arbitrary repo/folder: assume Whisper-shaped, pick whatever
                # runtime this machine actually has.
                model_desc = dict(registry.MODELS['whisper-large-v3'])
                model_desc['repo'] = custom
                model_desc['label'] = custom
                if not registry.engine_available(model_desc['engine']):
                    for eng in (registry.ENGINE_TRANSFORMERS, registry.ENGINE_FASTER_WHISPER):
                        if registry.engine_available(eng):
                            model_desc['engine'] = eng
                            break
            else:
                model_desc = dict(registry.get(opts.get('model')))

            # Guard the English-only trap rather than returning silent nonsense.
            lang = opts.get('language')
            if model_desc.get('english_only') and lang not in (None, '', 'auto', 'en'):
                raise RuntimeError(
                    f'{model_desc["label"]} is an English-only model, but "{lang}" was requested. '
                    'Choose a multilingual model, or set the language to English.')

            def report(frac, message):
                if job.cancelled:
                    raise _Cancelled()
                job.progress = max(0.0, min(0.99, frac))
                job.message = message

            terms = vocab.parse_terms(opts.get('vocabulary'))
            opts = dict(opts, terms=terms)

            # Audio the model will actually see. Kept separate from the audio the
            # timings are measured against, which stays the original.
            model_audio = job.audio_path
            separated = None

            if opts.get('suppress_music'):
                job.state = 'separating'
                job.message = 'Isolating dialogue from the music bed…'
                separated = audio_tools.isolate_vocals(job.audio_path, progress_cb=report)
                if separated:
                    model_audio = separated
                    job.notes.append('Dialogue isolated with Demucs.')
                elif audio_tools.demucs_available():
                    job.notes.append(
                        'Music suppression failed, so the original mix was used.')
                else:
                    job.notes.append(
                        'Music suppression unavailable, so the original mix was used. '
                        'Install the Demucs runtime in Settings to enable it.')

            # Voice activity is measured on the original audio, since separation
            # changes levels. Used to discard words that land in silence.
            regions = None
            if opts.get('vad', True):
                regions = audio_tools.speech_regions(job.audio_path)

            try:
                engine = engines_mod.build_engine(model_desc, opts)
                job.state = 'loading'
                engine.load(progress_cb=report)

                if job.cancelled:
                    raise _Cancelled()

                job.state = 'transcribing'
                job.message = 'Transcribing…'
                raw = engine.transcribe(model_audio, opts, progress_cb=report)
            finally:
                if separated:
                    audio_tools.cleanup_dir_of(separated)

            if job.cancelled:
                raise _Cancelled()

            words = raw.get('words') or []
            text = (raw.get('text') or ' '.join(s['text'] for s in raw.get('segments', []))).strip()
            alignment_used = False

            wants_alignment = opts.get('align', 'auto')
            should_align = (
                wants_alignment is True
                or (wants_alignment == 'auto' and (not words or model_desc.get('needs_alignment')))
            )

            if should_align and text:
                job.state = 'aligning'
                job.message = 'Aligning word timings…'
                aligner = engines_mod.ForcedAligner()
                aligned = aligner.align(job.audio_path, text,
                                        language=raw.get('language'), progress_cb=report)
                if aligned:
                    words = aligned
                    alignment_used = True
                elif not words:
                    raise RuntimeError(
                        'This model reports no word timings, and forced alignment is unavailable. '
                        'Install the aligner from Settings (needs torch + torchaudio), or pick a '
                        'model that provides its own timings, such as Whisper or Parakeet.')

            # Drop words the detector places in silence. These are almost always
            # hallucinated lines over music or room tone.
            dropped = 0
            if regions is not None and words:
                words, dropped = audio_tools.drop_words_in_silence(words, regions)
                if dropped:
                    job.notes.append(f'Removed {dropped} word(s) detected in silence.')

            # Vocabulary pass. Runs for every engine, including the ones that
            # cannot be prompted at all.
            corrections = []
            if terms and words:
                words, corrections = vocab.apply_terms(words, terms)
                if corrections:
                    job.notes.append(f'Applied {len(corrections)} vocabulary correction(s).')

            if words:
                text = ' '.join(w['word'] for w in words).strip()

            # Who said each word. Measured on the original audio for the same
            # reason VAD is: separation and level matching change the voice the
            # embeddings describe.
            turns = []
            if opts.get('diarize') and words:
                job.state = 'diarizing'
                job.message = 'Separating speakers…'
                turns = self._diarize(job, words, opts, report)
                # diarize swallows every exception, cancellation included, so the
                # flag is re-read here rather than trusted to have propagated.
                if job.cancelled:
                    raise _Cancelled()

            segments = raw.get('segments') or []
            if turns:
                # One segment per turn, so the caption segmenter downstream can
                # never draw a caption across two people.
                segments = _segments_from_words(words)
            elif words and (dropped or corrections or not any(s.get('words') for s in segments)):
                segments = [{'start': words[0]['start'], 'end': words[-1]['end'],
                             'text': text, 'words': words}]

            confidence = _confidence_summary(words)

            job.progress = 1.0
            job.state = 'done'
            job.message = f'Transcribed {len(words)} words.'
            job.result = {
                'segments': segments,
                'words': words,
                'language': raw.get('language'),
                'text': text,
                'engine': model_desc['engine'],
                'model': model_desc.get('label') or model_desc['repo'],
                'alignment_used': alignment_used,
                'separated': bool(separated),
                'vad_dropped': dropped,
                'speech_seconds': round(audio_tools.speech_seconds(regions), 2) if regions else None,
                'corrections': corrections,
                'confidence': confidence,
                'speakers': turns,
                'speaker_count': len(set(t['speaker'] for t in turns)) if turns else 0,
                'notes': job.notes,
            }
        except _Cancelled:
            job.state = 'cancelled'
            job.message = 'Cancelled.'
        except Exception as e:
            job.state = 'error'
            job.error = f'{e}'
            job.message = str(e)
            job.trace = traceback.format_exc(limit=3)


def _segments_from_words(words):
    """
    One segment per unbroken run of words by the same person.

    The front-end flattens segments back into a word list, so the split matters
    less than the label riding on each word — but a segment that spans two
    voices would be a lie in the transcript view and in anything exported from
    the raw result, so the boundary is drawn here as well.
    """
    segments = []
    for w in words:
        speaker = w.get('speaker') or ''
        if segments and segments[-1].get('speaker') == speaker:
            segments[-1]['words'].append(w)
            segments[-1]['end'] = w['end']
        else:
            segments.append({'start': w['start'], 'end': w['end'],
                             'speaker': speaker, 'words': [w]})
    for seg in segments:
        seg['text'] = ' '.join(w['word'] for w in seg['words']).strip()
    return segments


def _confidence_summary(words):
    """
    Per-word confidence, where the engine reports it.

    `reported` is False when every word came back at 1.0, which is what an engine
    without confidence output looks like. Saying so is better than showing a
    review UI built on a constant.
    """
    values = []
    for w in words or []:
        try:
            values.append(float(w.get('probability', 1.0)))
        except (TypeError, ValueError):
            values.append(1.0)

    if not values:
        return {'reported': False, 'min': None, 'mean': None, 'low_count': 0}

    reported = any(v < 0.999 for v in values)
    return {
        'reported': reported,
        'min': round(min(values), 4),
        'mean': round(sum(values) / len(values), 4),
        'low_count': sum(1 for v in values if v < LOW_CONFIDENCE) if reported else 0,
    }


class _Cancelled(Exception):
    pass
