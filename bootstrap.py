"""
Environment bootstrap.

The app owns its own virtual environment. On launch it creates that venv if
missing, installs the base dependencies into it, and re-executes itself with the
venv's interpreter. Nothing is ever installed into the user's system Python.

Why this exists rather than a README line telling people to run pip:

  * On macOS with Homebrew Python (and on Debian/Ubuntu), `pip install` against
    the system interpreter is refused outright under PEP 668
    ("externally-managed-environment"), so the documented setup step simply
    failed for a lot of people.
  * Installing an app's dependencies globally pollutes every other Python
    project on the machine.
  * Owning the venv also means the app can install its own *optional* runtimes
    later from the Settings panel, so nobody needs a terminal at all.

Where the venv lives matters as much as owning it. It goes in the per-user
application-support directory on the boot volume, keyed by a hash of the project
path — not next to the project. macOS refuses to dlopen native extensions from
external and network volumes ("library load disallowed by system policy"), so an
environment beside a project on /Volumes/… cannot load PyObjC and pywebview ends
up with no GUI backend at all. Editing projects live on external drives as a
matter of course, so the environment has to sit somewhere the system will execute
from. Set TRANSCRIBER_VENV to override the location.

This module deliberately uses only the standard library — it has to run before
anything is installed.
"""

import hashlib
import os
import platform
import shutil
import subprocess
import sys
import venv

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
LEGACY_VENV_DIR = os.path.join(PROJECT_DIR, '.venv')
GUARD_ENV = 'TRANSCRIBER_BOOTSTRAPPED'
VENV_OVERRIDE_ENV = 'TRANSCRIBER_VENV'
APP_DIR_NAME = 'TaylorsTranscriber'

MIN_PYTHON = (3, 9)

# Written into the app directory by the packaging scripts. Its presence is what
# separates an installed copy (DMG / setup.exe / AppImage) from a source
# checkout, and it changes three things: the environment is keyed by app
# identity rather than by folder path, the base dependencies are already present
# inside the bundle so first launch needs no network, and the environment is
# created with access to the bundle's own site-packages.
BUNDLE_MARKER = os.path.join(PROJECT_DIR, '.bundled')


def is_bundled():
    return os.path.isfile(BUNDLE_MARKER)


def app_support_dir():
    """
    Per-user data directory on the *boot* volume.

    This matters more than it looks. macOS refuses to dlopen native extensions
    from external and network volumes — "library load disallowed by system
    policy" — so a venv sitting next to a project on /Volumes/… cannot load
    pyobjc, and pywebview then has no GUI backend at all. Editing projects live
    on big external drives all the time, so the environment goes somewhere the
    system will actually execute from.
    """
    home = os.path.expanduser('~')
    if sys.platform == 'darwin':
        base = os.path.join(home, 'Library', 'Application Support', APP_DIR_NAME)
    elif os.name == 'nt':
        base = os.path.join(os.environ.get('LOCALAPPDATA') or os.path.join(home, 'AppData', 'Local'),
                            APP_DIR_NAME)
    else:
        base = os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.join(home, '.local', 'share'),
                            'taylors-transcriber')
    return base


def _project_key():
    """Short stable id for this checkout, so several copies never share a venv."""
    try:
        real = os.path.realpath(PROJECT_DIR)
    except OSError:
        real = PROJECT_DIR
    return hashlib.sha256(real.encode('utf-8')).hexdigest()[:10]


def resolve_venv_dir():
    override = os.environ.get(VENV_OVERRIDE_ENV)
    if override:
        return os.path.abspath(os.path.expanduser(override))
    # An installed app has one identity and one environment, whatever folder it
    # was installed into. That is what lets an update installed over the top keep
    # the multi-gigabyte runtimes the user added from Settings. Source checkouts
    # stay keyed by path, so several clones never share an environment.
    name = 'venv' if is_bundled() else f'venv-{_project_key()}'
    try:
        base = app_support_dir()
        os.makedirs(base, exist_ok=True)
        return os.path.join(base, name)
    except OSError:
        import tempfile
        return os.path.join(tempfile.gettempdir(), f'{APP_DIR_NAME}-{name}')


VENV_DIR = resolve_venv_dir()
STAMP_FILE = os.path.join(VENV_DIR, '.deps-stamp')


def base_requirements():
    """
    Minimum needed for the window to open. Everything heavier (speech runtimes,
    torch) is optional and installed on demand from Settings.

    pywebview needs a platform GUI binding, and the bare package does not always
    pull one. Asking for the right extra explicitly avoids the "you must have
    either PyObjC or Qt installed" failure at startup.
    """
    if is_bundled():
        # Already inside the bundle's own interpreter. The environment is created
        # with system-site-packages so it can see them, so there is nothing to
        # fetch and the first launch works with no network at all.
        return []
    reqs = ['huggingface-hub>=0.23.0']
    if sys.platform == 'darwin':
        reqs.insert(0, 'pywebview[cocoa]>=4.4')
    else:
        reqs.insert(0, 'pywebview>=4.4')
    return reqs


# Kept for callers/tests that reference it directly.
BASE_REQUIREMENTS = base_requirements()


def venv_python(venv_dir=VENV_DIR):
    if os.name == 'nt':
        return os.path.join(venv_dir, 'Scripts', 'python.exe')
    return os.path.join(venv_dir, 'bin', 'python')


def in_project_venv():
    """
    True when the running interpreter is the project's own venv Python.

    This compares sys.prefix, not sys.executable. A venv created with symlinks
    has .venv/bin/python pointing straight at the system interpreter, so
    os.path.samefile() on the executables follows the link and reports a match
    from *outside* the venv too — which would stop the re-exec from ever
    happening and leave every installed dependency invisible. sys.prefix is the
    venv root when running inside it and the base prefix otherwise, so it
    answers the question being asked.
    """
    try:
        return os.path.samefile(sys.prefix, VENV_DIR)
    except OSError:
        return os.path.normcase(os.path.abspath(sys.prefix)) == \
               os.path.normcase(os.path.abspath(VENV_DIR))


def requirements_stamp():
    """Hash of what we intend to install, so we only re-run pip when it changes."""
    h = hashlib.sha256()
    h.update(('\n'.join(BASE_REQUIREMENTS)).encode())
    h.update(platform.python_version().encode())
    return h.hexdigest()


def legacy_venv_is_stale():
    """
    True when an old in-project .venv exists and is not the one we now use.

    Earlier versions created the environment next to the project. Those copies
    are the ones that fail to load native libraries on external volumes, so it
    is worth telling the user they are dead weight.
    """
    if not os.path.isdir(LEGACY_VENV_DIR):
        return False
    try:
        return not os.path.samefile(LEGACY_VENV_DIR, VENV_DIR)
    except OSError:
        return True  # VENV_DIR does not exist yet, so the legacy one is unused


def on_external_volume(path=PROJECT_DIR):
    """Best-effort: is this path on a volume other than the boot volume?"""
    if sys.platform != 'darwin':
        return False
    try:
        return os.path.realpath(path).startswith('/Volumes/')
    except OSError:
        return False


def stamp_is_current():
    try:
        with open(STAMP_FILE, encoding='utf-8') as fh:
            return fh.read().strip() == requirements_stamp()
    except OSError:
        return False


def write_stamp():
    try:
        with open(STAMP_FILE, 'w', encoding='utf-8') as fh:
            fh.write(requirements_stamp())
    except OSError:
        pass


def _log(msg):
    print(f'[setup] {msg}', flush=True)


def create_venv():
    _log(f'Creating a virtual environment at {VENV_DIR}')
    # with_pip=True gives us pip inside the venv without needing ensurepip
    # separately; symlinks keep it small on Unix.
    #
    # A bundled build layers its environment on top of the interpreter shipped
    # inside the app, which already carries pywebview and huggingface-hub. The
    # environment then holds only the optional runtimes the user chooses to
    # install, and anything installed there still shadows the bundled copy.
    builder = venv.EnvBuilder(with_pip=True, symlinks=(os.name != 'nt'),
                              system_site_packages=is_bundled(), upgrade=False)
    builder.create(VENV_DIR)


def venv_is_usable():
    """
    True when the existing environment still works with the interpreter we are.

    A virtual environment is bound to the exact minor version of the interpreter
    that created it — its site-packages lives under lib/pythonX.Y. When an app
    update ships a newer Python, the old environment silently stops resolving
    imports, so it has to be rebuilt rather than limped along. Releases keep the
    bundled Python's minor version fixed precisely so this stays rare: it costs
    the user their installed runtimes.
    """
    py = venv_python()
    if not os.path.isfile(py):
        return False
    try:
        out = subprocess.run(
            [py, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    if out.returncode != 0:
        return False
    return out.stdout.strip() == '%d.%d' % sys.version_info[:2]


def rebuild_venv():
    """Discard an environment the current interpreter can no longer use."""
    _log('The app environment was built for a different Python and must be '
         'rebuilt. Speech runtimes installed from Settings will need '
         'installing again.')
    try:
        shutil.rmtree(VENV_DIR)
    except OSError as e:
        sys.exit(f'Could not remove the stale environment at {VENV_DIR}:\n  {e}')
    create_venv()


def pip_install(args, python=None, quiet=True):
    python = python or venv_python()
    cmd = [python, '-m', 'pip', 'install', '--disable-pip-version-check']
    if quiet:
        cmd.append('-q')
    cmd += list(args)
    return subprocess.run(cmd, cwd=PROJECT_DIR)


def install_base_requirements():
    globals()['BASE_REQUIREMENTS'] = base_requirements()
    if not BASE_REQUIREMENTS:
        # Bundled build: nothing to fetch, just record what this environment was
        # built against so a later app update notices the change.
        write_stamp()
        return True
    _log('Installing base dependencies (one-time, ~20 MB)…')
    # Upgrading pip first avoids a class of resolver and wheel-format failures
    # on the pip that ships inside older venvs.
    subprocess.run([venv_python(), '-m', 'pip', 'install', '-q', '--upgrade',
                    'pip', 'setuptools', 'wheel'], cwd=PROJECT_DIR)
    result = pip_install(BASE_REQUIREMENTS)
    if result.returncode != 0:
        _log('Base dependency install failed. See the pip output above.')
        return False
    write_stamp()
    _log('Base dependencies ready.')
    return True


def ensure_environment(argv=None):
    """
    Guarantee we are running inside the project venv with base deps present.

    Re-executes the process with the venv interpreter when needed, so callers
    should treat a return from this function as "we are good to continue".
    """
    if sys.version_info < MIN_PYTHON:
        sys.exit(f'Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer is required '
                 f'(this is {platform.python_version()}).')

    # Already re-executed once — never loop, whatever the state.
    if os.environ.get(GUARD_ENV) == '1':
        return

    if in_project_venv():
        if not stamp_is_current():
            install_base_requirements()
        os.environ[GUARD_ENV] = '1'
        return

    if on_external_volume() and not os.environ.get(VENV_OVERRIDE_ENV):
        _log(f'Project is on an external volume; keeping the environment at {VENV_DIR}')
        _log('(macOS will not load native libraries from /Volumes.)')

    if legacy_venv_is_stale():
        _log(f'Note: the old in-project environment at {LEGACY_VENV_DIR} is no longer '
             'used and can be deleted.')

    if os.path.isdir(VENV_DIR) and not venv_is_usable():
        rebuild_venv()

    if not os.path.isfile(venv_python()):
        try:
            create_venv()
        except Exception as e:
            sys.exit(f'Could not create the virtual environment at {VENV_DIR}:\n  {e}\n\n'
                     'If your Python lacks the venv module, install it '
                     '(e.g. "sudo apt install python3-venv") and try again.')

    if not stamp_is_current():
        if not install_base_requirements():
            sys.exit('Setup could not complete. See the pip output above.')

    # Hand over to the venv interpreter.
    env = dict(os.environ)
    env[GUARD_ENV] = '1'
    script = os.path.abspath(sys.argv[0])
    args = [venv_python(), script] + (argv if argv is not None else sys.argv[1:])
    _log('Starting in the project environment…')

    if os.name == 'nt':
        # Windows has no exec that replaces the process cleanly for GUI apps.
        sys.exit(subprocess.run(args, env=env, cwd=PROJECT_DIR).returncode)
    os.execve(args[0], args, env)


def diagnose_gui_backend():
    """
    Work out whether pywebview can actually open a window, and why not if it
    cannot. Returns (ok, message).

    pywebview raises a single generic error covering every reason its GUI
    backend is unavailable, which is unhelpful when the real cause is macOS
    refusing to load a library from an external volume. This separates the
    common causes so the user gets an answer rather than a stack trace.
    """
    try:
        import webview  # noqa: F401
    except ImportError:
        return False, 'pywebview is not installed in the app environment.'

    if sys.platform == 'darwin':
        try:
            import objc  # noqa: F401
            import WebKit  # noqa: F401
            return True, 'Cocoa backend available.'
        except ImportError as e:
            return False, (f'PyObjC is missing or incomplete ({e}). '
                           'Delete the app environment and relaunch to reinstall it.')
        except Exception as e:
            msg = str(e)
            if 'not valid for use in process' in msg or 'disallowed by system policy' in msg:
                return False, (
                    'macOS blocked loading PyObjC from this location.\n'
                    'This happens when the environment sits on an external or network '
                    f'volume. The environment is at:\n  {VENV_DIR}\n'
                    'If that path is on an external drive, set TRANSCRIBER_VENV to a '
                    'folder on your internal disk and relaunch.')
            return False, f'The Cocoa backend failed to load: {msg}'

    if os.name == 'nt':
        return True, 'EdgeChromium backend expected.'

    try:
        import gi  # noqa: F401
        return True, 'GTK backend available.'
    except Exception:
        pass
    try:
        import qtpy  # noqa: F401
        return True, 'Qt backend available.'
    except Exception:
        pass
    return False, ('No GUI backend found. Install GTK bindings '
                   '(e.g. "sudo apt install python3-gi gir1.2-webkit2-4.1") '
                   'or Qt bindings, or use the browser fallback.')


# ---------------------------------------------------------------------------
# Optional runtime installation (called from the Settings panel)
# ---------------------------------------------------------------------------

def can_install_runtimes():
    """
    Only ever install into our own venv. If the app is somehow running against
    a different interpreter, refuse rather than touching it.
    """
    return in_project_venv() or os.environ.get(GUARD_ENV) == '1'


def install_packages_streaming(packages, on_line=None):
    """
    pip install with output streamed line by line so the UI can show progress.
    @returns (ok, last_lines)
    """
    if not can_install_runtimes():
        return False, ['Refusing to install: not running inside the project '
                       'virtual environment.']

    cmd = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
           '--progress-bar', 'off'] + list(packages)

    tail = []
    proc = subprocess.Popen(cmd, cwd=PROJECT_DIR, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        tail.append(line)
        del tail[:-40]
        if on_line:
            on_line(line)
    proc.wait()
    return proc.returncode == 0, tail
