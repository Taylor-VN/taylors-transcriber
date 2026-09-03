"""
Taylor's Transcriber — desktop shell.

Serves the interface from a local HTTP server and opens it in a native window.
If no native GUI backend can be loaded, falls back to the default browser and
exposes the same backend API over an authenticated localhost bridge, so exporting
and transcription keep working.
"""

import os
import sys
import base64
import json
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import http.server
import socketserver
import uuid
import webbrowser

import version
from transcriber import Transcriber
from fonts import FontIndex

try:
    import webview
except ImportError:  # pragma: no cover - only hit when pywebview is missing
    webview = None


DIRECTORY = os.path.dirname(os.path.abspath(__file__))


def find_available_port(default_port=8000):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(('127.0.0.1', default_port)) != 0:
            return default_port
    # If default port is in use, request open port from OS
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def find_ffmpeg():
    """Locate an ffmpeg binary, including the usual GUI-app-blind spots."""
    # The bundled copy wins over anything on PATH: it is the build we tested the
    # ProRes export against, and installed users should not silently inherit
    # whatever ffmpeg happens to be on the machine.
    bundled = os.path.join(DIRECTORY, 'bin',
                           'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
    if os.path.isfile(bundled) and os.access(bundled, os.X_OK):
        return bundled

    found = shutil.which('ffmpeg')
    if found:
        return found
    for candidate in (
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/usr/bin/ffmpeg',
        '/snap/bin/ffmpeg',
        os.path.join(DIRECTORY, 'bin', 'ffmpeg'),
        r'C:\ffmpeg\bin\ffmpeg.exe',
    ):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


# Shared secret for the HTTP bridge used by the browser fallback. Regenerated
# every launch; without it the API endpoints refuse to answer, so another local
# process or a web page cannot drive the backend.
API_TOKEN = secrets.token_urlsafe(24)

# Set when running without a native window, so the API bridge is only reachable
# in the mode that actually needs it.
BRIDGE_ENABLED = False
BRIDGE_API = None

# Methods the browser fallback may call. save_text_file, project_save and
# project_open are deliberately excluded: they need a native file dialog, and
# without one they would write server-side to a guessed directory. In browser
# mode the page downloads the project instead and opens it through a file input.
BRIDGE_METHODS = {
    'get_capabilities',
    'transcribe_probe', 'transcribe_begin', 'transcribe_push_audio',
    'transcribe_finish_audio', 'transcribe_status', 'transcribe_cancel',
    'transcribe_cleanup',
    'models_list', 'model_install', 'model_install_status',
    'model_install_cancel', 'model_remove',
    'runtimes_list', 'runtime_install', 'runtime_install_status',
    'begin_export', 'write_frame', 'repeat_frame', 'encode_prores', 'cleanup_export',
}

MAX_BRIDGE_BODY = 64 * 1024 * 1024  # frames and audio chunks are the large ones


class CustomHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        pass

    # --- security -------------------------------------------------------
    def _host_is_local(self):
        """Guards against DNS rebinding: only answer to a loopback Host."""
        host = (self.headers.get('Host') or '').split(':')[0].strip('[]')
        return host in ('127.0.0.1', 'localhost', '::1', '')

    def _authorised(self):
        return self.headers.get('X-Api-Token') == API_TOKEN

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    # --- API bridge -----------------------------------------------------
    def do_POST(self):
        if not self.path.startswith('/__api/'):
            self.send_error(404)
            return
        if not BRIDGE_ENABLED or BRIDGE_API is None:
            self._send_json({'ok': False, 'error': 'The API bridge is not enabled.'}, 403)
            return
        if not self._host_is_local() or not self._authorised():
            self._send_json({'ok': False, 'error': 'Not authorised.'}, 403)
            return

        method = self.path[len('/__api/'):]
        if method not in BRIDGE_METHODS:
            self._send_json({'ok': False, 'error': f'Unknown method "{method}".'}, 404)
            return

        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length > MAX_BRIDGE_BODY:
                self._send_json({'ok': False, 'error': 'Request too large.'}, 413)
                return
            raw = self.rfile.read(length) if length else b'{}'
            args = json.loads(raw or b'{}').get('args', [])
            if not isinstance(args, list):
                args = [args]
            result = getattr(BRIDGE_API, method)(*args)
            self._send_json({'ok': True, 'result': result})
        except Exception as e:
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def do_GET(self):
        # The page needs to know whether a bridge exists and what token to use.
        if self.path.split('?')[0] == '/__api/config':
            if not self._host_is_local():
                self._send_json({'ok': False}, 403)
                return
            self._send_json({'ok': True, 'bridge': BRIDGE_ENABLED,
                             'token': API_TOKEN if BRIDGE_ENABLED else None})
            return
        super().do_GET()


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded so a long transcription call cannot block the page from loading."""
    daemon_threads = True
    allow_reuse_address = True


def run_server(port):
    try:
        with ThreadingHTTPServer(("127.0.0.1", port), CustomHTTPRequestHandler) as httpd:
            httpd.serve_forever()
    except Exception as e:
        print(f"Server notice: {e}")


class ExportApi:
    """
    Bridge exposed to the page as window.pywebview.api.

    The front-end renders each caption frame to a transparent PNG and streams it
    here; we drop the frames on disk and let ffmpeg mux them into a ProRes 4444
    QuickTime file that carries a genuine alpha channel.
    """

    def __init__(self):
        self.jobs = {}
        self._lock = threading.Lock()
        self.transcriber = Transcriber()
        self.font_index = FontIndex()

    # --- capability probe -------------------------------------------------
    def get_capabilities(self):
        ffmpeg = find_ffmpeg()
        return {
            'ok': True,
            'native': True,
            'version': version.__version__,
            'ffmpeg': bool(ffmpeg),
            'ffmpeg_path': ffmpeg or '',
        }

    # --- AI transcription (see transcriber.py) ----------------------------
    def transcribe_probe(self):
        return self.transcriber.probe()

    def transcribe_begin(self, options):
        return self.transcriber.begin(options)

    def transcribe_push_audio(self, job_id, b64_chunk):
        return self.transcriber.push_audio(job_id, b64_chunk)

    def transcribe_finish_audio(self, job_id):
        return self.transcriber.finish_audio_and_run(job_id)

    def transcribe_status(self, job_id):
        return self.transcriber.status(job_id)

    def transcribe_cancel(self, job_id):
        return self.transcriber.cancel(job_id)

    def transcribe_cleanup(self, job_id):
        return self.transcriber.cleanup(job_id)

    # --- model management -------------------------------------------------
    def models_list(self):
        return self.transcriber.list_models()

    def model_install(self, model_id):
        return self.transcriber.install_model(model_id)

    def model_install_status(self, job_id):
        return self.transcriber.install_status(job_id)

    def model_install_cancel(self, job_id):
        return self.transcriber.cancel_install(job_id)

    def model_remove(self, model_id):
        return self.transcriber.remove_model(model_id)

    # --- optional runtime management --------------------------------------
    def runtimes_list(self):
        return self.transcriber.list_runtimes()

    def runtime_install(self, runtime_id):
        return self.transcriber.install_runtime(runtime_id)

    def runtime_install_status(self, job_id):
        return self.transcriber.runtime_install_status(job_id)

    # --- installed fonts ---------------------------------------------------
    def fonts_list(self, refresh=False):
        """
        Family names of every installed font, for the typography dropdown.

        Families whose name starts with a dot are Apple's internal UI faces
        (".SF NS", ".Aqua Kana"); they are not licensed for use as a caption
        font and every other font menu hides them, so this does too. Resolving
        one by name still works — only the offered list is filtered.
        """
        try:
            families = sorted({
                f['family'] for f in self.font_index.faces(refresh=bool(refresh))
                if f.get('family') and not f['family'].startswith('.')
            }, key=str.lower)
            return {'ok': True, 'families': families}
        except Exception as e:
            return {'ok': False, 'error': str(e), 'families': []}

    def font_resolve(self, name):
        """
        Locates an installed font by Premiere's PostScript name and returns its
        bytes, so the page can register it with FontFace and draw captions in
        the real typeface instead of silently falling back to sans-serif.
        """
        try:
            face = self.font_index.resolve(name)
            if not face:
                return {'ok': False, 'error': 'not_installed', 'requested': name}
            with open(face['path'], 'rb') as fh:
                data = fh.read()
            ext = os.path.splitext(face['path'])[1].lower()
            fmt = {'.otf': 'opentype', '.ttf': 'truetype',
                   '.ttc': 'collection', '.otc': 'collection'}.get(ext, 'opentype')
            return {
                'ok': True,
                'requested': name,
                'postscript': face.get('postscript', ''),
                'family': face.get('family', ''),
                'subfamily': face.get('subfamily', ''),
                'format': fmt,
                'path': face['path'],
                'data': base64.b64encode(data).decode('ascii'),
            }
        except Exception as e:
            return {'ok': False, 'error': str(e), 'requested': name}

    # --- export lifecycle -------------------------------------------------
    def begin_export(self, meta):
        try:
            if not find_ffmpeg():
                return {
                    'ok': False,
                    'error': 'ffmpeg was not found on this system. Install ffmpeg '
                             '(e.g. "brew install ffmpeg") and relaunch, or use the '
                             'PNG sequence export instead.'
                }
            job_id = uuid.uuid4().hex
            frames_dir = tempfile.mkdtemp(prefix=f'subtitler_{job_id}_')
            with self._lock:
                self.jobs[job_id] = {
                    'dir': frames_dir,
                    'meta': meta or {},
                    'last_frame': None,
                }
            return {'ok': True, 'job_id': job_id}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def write_frame(self, job_id, index, b64_png):
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown export job.'}
            path = os.path.join(job['dir'], f'frame_{index:06d}.png')
            with open(path, 'wb') as fh:
                fh.write(base64.b64decode(b64_png))
            job['last_frame'] = path
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def repeat_frame(self, job_id, index):
        """Duplicate the previous frame without re-sending its bytes over the bridge."""
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown export job.'}
            last = job.get('last_frame')
            if not last or not os.path.exists(last):
                return {'ok': False, 'error': 'No previous frame to repeat.'}
            path = os.path.join(job['dir'], f'frame_{index:06d}.png')
            try:
                os.link(last, path)  # hard link: no extra disk, no copy cost
            except OSError:
                shutil.copyfile(last, path)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def encode_prores(self, job_id, opts):
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown export job.'}

            ffmpeg = find_ffmpeg()
            if not ffmpeg:
                return {'ok': False, 'error': 'ffmpeg was not found on this system.'}

            opts = opts or {}
            fps = opts.get('fps', 25)
            profile = int(opts.get('profile', 4))  # 4 = ProRes 4444, 5 = 4444 XQ
            filename = opts.get('filename') or 'subtitles_alpha.mov'
            if not filename.lower().endswith('.mov'):
                filename += '.mov'

            out_path = self._ask_save_path(filename)
            if not out_path:
                return {'ok': False, 'error': 'Export cancelled.'}

            cmd = [
                ffmpeg, '-y',
                '-framerate', str(fps),
                '-i', os.path.join(job['dir'], 'frame_%06d.png'),
                '-c:v', 'prores_ks',
                '-profile:v', str(profile),
                '-pix_fmt', 'yuva444p10le',
                '-alpha_bits', '16',
                '-vendor', 'apl0',
                '-r', str(fps),
                out_path,
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                tail = (proc.stderr or '').strip().splitlines()[-6:]
                return {'ok': False, 'error': 'ffmpeg failed:\n' + '\n'.join(tail)}

            return {'ok': True, 'path': out_path}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def cleanup_export(self, job_id):
        try:
            with self._lock:
                job = self.jobs.pop(job_id, None)
            if job and os.path.isdir(job['dir']):
                shutil.rmtree(job['dir'], ignore_errors=True)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    # --- generic file save (used by SRT/VTT/XML/preset exports too) --------
    def save_text_file(self, filename, content):
        try:
            out_path = self._ask_save_path(filename)
            if not out_path:
                return {'ok': False, 'error': 'Save cancelled.'}
            with open(out_path, 'w', encoding='utf-8') as fh:
                fh.write(content)
            return {'ok': True, 'path': out_path}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    # --- project files (.ttproj) ------------------------------------------
    def project_save(self, filename, content, path=''):
        """
        Write the project.

        A path means "the user already told us where this project lives" — a
        plain Save then overwrites it silently, which is what Cmd+S has to do
        while working. Without one a save dialog is shown, so Save As and the
        first save of a new project both land here.
        """
        try:
            out_path = path if path else self._ask_save_path(filename)
            if not out_path:
                return {'ok': False, 'error': 'Save cancelled.'}
            parent = os.path.dirname(out_path)
            if parent and not os.path.isdir(parent):
                return {'ok': False,
                        'error': f'The folder "{parent}" no longer exists. Use Save As.'}
            with open(out_path, 'w', encoding='utf-8') as fh:
                fh.write(content)
            return {'ok': True, 'path': out_path}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def project_open(self):
        try:
            in_path = self._ask_open_path()
            if not in_path:
                return {'ok': False, 'error': 'Open cancelled.'}
            with open(in_path, 'r', encoding='utf-8') as fh:
                content = fh.read()
            return {'ok': True, 'path': in_path, 'content': content}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def _ask_open_path(self):
        if webview is None or not webview.windows:
            return None
        result = webview.windows[0].create_file_dialog(
            webview.OPEN_DIALOG,
            directory=os.path.expanduser('~'),
            allow_multiple=False,
            file_types=("Transcriber project (*.ttproj;*.json)", "All files (*.*)"),
        )
        if not result:
            return None
        return result if isinstance(result, str) else result[0]

    def _ask_save_path(self, filename):
        if webview is None or not webview.windows:
            return os.path.join(os.path.expanduser('~'), filename)
        result = webview.windows[0].create_file_dialog(
            webview.SAVE_DIALOG,
            directory=os.path.expanduser('~'),
            save_filename=filename,
        )
        if not result:
            return None
        return result if isinstance(result, str) else result[0]


def launch_native(port, api):
    """Open the pywebview window. Returns False if no GUI backend will load."""
    ok, message = bootstrap.diagnose_gui_backend()
    if not ok:
        print('\nCould not open a native window:')
        for line in message.splitlines():
            print(f'  {line}')
        return False

    webview.create_window(
        title="Taylor's Transcriber — Premiere Captions Editor",
        url=f'http://127.0.0.1:{port}',
        js_api=api,
        width=1400,
        height=900,
        resizable=True,
        min_size=(1024, 700),
        background_color='#121212'
    )
    try:
        webview.start()
        return True
    except Exception as e:
        print(f'\nThe native window failed to start: {e}')
        return False


def launch_browser(port, api):
    """
    Fallback when no native GUI backend is available.

    The whole interface is already served over the local HTTP server, so the app
    works in a browser. The only piece pywebview normally provides is the
    js_api bridge, which is exposed over authenticated localhost HTTP instead —
    so exporting and transcription keep working rather than being disabled.
    """
    global BRIDGE_ENABLED, BRIDGE_API
    BRIDGE_API = api
    BRIDGE_ENABLED = True

    url = f'http://127.0.0.1:{port}/index.html'
    print('\nFalling back to your browser.')
    print(f'  {url}')
    print('  Backend features (ProRes export, transcription) work in this mode too.')
    print('  Text exports download through the browser instead of a save dialog.')
    print('\nPress Ctrl+C to quit.\n')

    try:
        webbrowser.open(url)
    except Exception:
        print('Could not open the browser automatically — open the URL above yourself.')

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print('\nShutting down.')


if __name__ == '__main__':
    if any(a in ('-h', '--help') for a in sys.argv[1:]):
        print(__doc__ or '')
        print('Usage: python3 app.py [--browser]\n')
        print('  --browser   Skip the native window and use your default browser.')
        print('              Backend features still work over an authenticated')
        print('              localhost bridge.\n')
        print('Environment:')
        print('  TRANSCRIBER_VENV   Override where the app keeps its virtual environment.')
        sys.exit(0)

    # Create/enter the app's own virtual environment before anything else. This
    # re-executes the process with the venv interpreter on first run.
    import bootstrap
    bootstrap.ensure_environment()

    import importlib
    if webview is None:
        try:
            webview = importlib.import_module('webview')
        except ImportError:
            pass

    force_browser = any(a in ('--browser', '--no-native') for a in sys.argv[1:])

    port = find_available_port(8000)

    # Start background local server for static files (and, in browser mode, the
    # API bridge).
    server_thread = threading.Thread(target=run_server, args=(port,), daemon=True)
    server_thread.start()

    print(f"Taylor's Transcriber starting on port {port}...")
    print(f"Environment: {bootstrap.VENV_DIR}")
    if find_ffmpeg():
        print(f"ffmpeg found at {find_ffmpeg()} — ProRes 4444 alpha export enabled.")
    else:
        print("ffmpeg NOT found — alpha export will fall back to a PNG sequence.")

    api = ExportApi()

    _probe = api.transcribe_probe()
    if _probe.get('available'):
        print(f"AI transcription ready via {', '.join(_probe['engines'])} on {_probe['device_name']}.")
        print(f"{_probe['installed_count']} model(s) installed. Manage them in Settings.")
        if _probe.get('apple_silicon') and 'faster-whisper' in _probe['engines'] \
                and not any(e.startswith('mlx') or 'parakeet' in e for e in _probe['engines']):
            print("Note: faster-whisper runs CPU-only on Apple Silicon. "
                  "Install mlx-whisper or parakeet-mlx in Settings to use the GPU.")
    else:
        print("AI transcription: no runtime installed yet. "
              "Open Settings in the app to install one.")

    if force_browser:
        print('Browser mode requested (--browser).')
        launch_browser(port, api)
    elif webview is None or not launch_native(port, api):
        launch_browser(port, api)
