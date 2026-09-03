#!/usr/bin/env python3
"""
Build the payload that every installer wraps.

All three installers contain the same three things, and this script assembles
them into a staging directory:

  python/     a complete, relocatable CPython with pip, from python-build-standalone
  app/        the application sources, plus a .bundled marker
  app/bin/    a small purpose-built ffmpeg

Why a real interpreter rather than a frozen binary. bootstrap.install_packages_
streaming runs `sys.executable -m pip install` so the Settings panel can add
speech runtimes on a button click, and audio_tools shells out to `sys.executable
-m demucs`. PyInstaller and py2app produce a binary with neither pip nor a usable
venv module, so freezing would take that feature away. Shipping the interpreter
keeps the existing architecture intact: the app still creates its environment in
the user's application-support directory, and still extends it on demand. The
only difference is that the interpreter it uses is the one inside the app rather
than one the user had to install.

Run directly to build for the host platform:

    python3 packaging/build_payload.py --dest build/payload

Environment overrides, for a reproducible rebuild of an older release:

    PBS_RELEASE     python-build-standalone release tag, e.g. 20250612
    FFMPEG_URL      exact archive URL to use instead of the resolved one
"""

import argparse
import io
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import version  # noqa: E402

# The bundled interpreter's minor version is part of the app's compatibility
# contract, not an incidental detail. A virtual environment is bound to the
# minor version that created it, so bumping this invalidates every user's
# environment and costs them the runtimes they installed (bootstrap.venv_is_
# usable notices and rebuilds, but the download is theirs to repeat). Change it
# deliberately, and say so in the release notes.
PYTHON_MINOR = '3.12'

# Kept in step with packaging/macos/build_ffmpeg.sh, which compiles this exact
# release. It also names the source and licence the bundle has to carry.
FFMPEG_VERSION = os.environ.get('FFMPEG_VERSION', '7.1')

PBS_API = ('https://api.github.com/repos/astral-sh/python-build-standalone'
           '/releases/tags/{tag}')
PBS_LATEST = ('https://api.github.com/repos/astral-sh/python-build-standalone'
              '/releases/latest')

# BtbN publishes LGPL builds, which are redistributable without the licence
# obligations a GPL build would place on this app. macOS is not among their
# targets, so that one is compiled from source — see build_ffmpeg_macos.sh.
BTBN_API = ('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest')

TARGETS = {
    'macos': {
        'triple': 'aarch64-apple-darwin',
        'requirements': ['pywebview[cocoa]>=4.4', 'huggingface-hub>=0.23.0'],
        'python_exe': os.path.join('bin', 'python3'),
        'ffmpeg_name': 'ffmpeg',
    },
    'windows': {
        'triple': 'x86_64-pc-windows-msvc',
        # pythonnet is what pywebview drives the EdgeChromium WebView2 control
        # through. Naming it explicitly avoids a bundle that imports webview
        # fine and then cannot open a window.
        'requirements': ['pywebview>=4.4', 'pythonnet>=3.0', 'huggingface-hub>=0.23.0'],
        'python_exe': 'python.exe',
        'ffmpeg_name': 'ffmpeg.exe',
        'btbn_match': 'win64-lgpl-shared',
    },
    'linux': {
        'triple': 'x86_64-unknown-linux-gnu',
        # No system GTK/WebKit to rely on across distributions, so the window
        # comes from Qt, which pip can install complete with its own WebEngine.
        # If it will not start, app.py already falls back to the browser, so a
        # minimal host without a desktop stack still runs.
        'requirements': ['pywebview>=4.4', 'qtpy>=2.4',
                         'PySide6-Essentials>=6.7', 'PySide6-Addons>=6.7',
                         'huggingface-hub>=0.23.0'],
        'python_exe': os.path.join('bin', 'python3'),
        'ffmpeg_name': 'ffmpeg',
        'btbn_match': 'linux64-lgpl-shared',
    },
}

# An explicit list, because an exclude list rots: a new data directory added to
# the project would silently miss the installers.
APP_FILES = [
    'app.py',
    'audio_tools.py',
    'bootstrap.py',
    'diarize.py',
    'engines.py',
    'fonts.py',
    'index.html',
    'model_registry.py',
    'styles.css',
    'transcriber.py',
    'version.py',
    'vocabulary.py',
]
APP_DIRS = ['js']


def log(msg):
    print(f'[payload] {msg}', flush=True)


def host_platform():
    if sys.platform == 'darwin':
        return 'macos'
    if os.name == 'nt':
        return 'windows'
    return 'linux'


def fetch(url):
    log(f'GET {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'taylors-transcriber-build'})
    token = os.environ.get('GITHUB_TOKEN')
    if token and 'api.github.com' in url:
        req.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(req) as r:
        return r.read()


def resolve_python_url(triple):
    """
    Find the install_only archive for our pinned minor version.

    install_only is the variant that extracts to a self-contained, relocatable
    python/ directory with pip present — which is exactly the shape we want to
    drop into an app bundle.
    """
    tag = os.environ.get('PBS_RELEASE')
    data = json.loads(fetch(PBS_API.format(tag=tag) if tag else PBS_LATEST))
    prefix = f'cpython-{PYTHON_MINOR}.'
    names = []
    for asset in data.get('assets', []):
        name = asset['name']
        names.append(name)
        if (name.startswith(prefix) and triple in name
                and name.endswith('-install_only.tar.gz')):
            return asset['browser_download_url']
    raise SystemExit(
        f'No CPython {PYTHON_MINOR} install_only build for {triple} in release '
        f'{data.get("tag_name")}.\nSet PBS_RELEASE to a release that has one. '
        f'Saw {len(names)} assets.')


def install_python(dest, triple):
    """Extract a relocatable CPython into dest/python."""
    url = resolve_python_url(triple)
    blob = fetch(url)
    log(f'Unpacking {len(blob) // (1024 * 1024)} MB interpreter')
    with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as tf:
        with tempfile.TemporaryDirectory() as tmp:
            tf.extractall(tmp)
            src = os.path.join(tmp, 'python')
            if not os.path.isdir(src):
                raise SystemExit(f'Unexpected archive layout from {url}')
            shutil.move(src, os.path.join(dest, 'python'))
    return url


def seed_requirements(dest, target):
    """
    Install the base dependencies into the bundled interpreter itself.

    This is what makes the first launch instant and offline. bootstrap.base_
    requirements() returns nothing for a bundled build, and the environment it
    creates in application support uses system-site-packages so it can see
    these; the optional runtimes the user installs later land in that
    environment and shadow them normally.
    """
    py = os.path.join(dest, 'python', target['python_exe'])
    log('Seeding base dependencies into the bundled interpreter')
    subprocess.run([py, '-m', 'pip', 'install', '--upgrade', 'pip'], check=True)
    subprocess.run([py, '-m', 'pip', 'install', '--no-warn-script-location']
                   + target['requirements'], check=True)
    # Compiled caches for someone else's absolute paths are dead weight in an
    # installer and a source of confusing tracebacks.
    subprocess.run([py, '-m', 'pip', 'cache', 'purge'], check=False)


def resolve_btbn_url(match):
    data = json.loads(fetch(BTBN_API))
    for asset in data.get('assets', []):
        name = asset['name']
        if match in name and (name.endswith('.zip') or name.endswith('.tar.xz')):
            return asset['browser_download_url']
    raise SystemExit(f'No FFmpeg-Builds asset matching {match!r}.')


def install_ffmpeg(dest, target, plat):
    """
    Put a single ffmpeg binary at dest/bin.

    The app needs a narrow slice of ffmpeg: decode a PNG sequence, encode
    prores_ks, mux to mov. None of that touches a GPL component, so an LGPL
    build is enough and there is no licence obligation on this app beyond
    shipping ffmpeg's own licence and source offer.
    """
    # Next to the app sources, because app.find_ffmpeg looks for its bundled
    # copy at <directory of app.py>/bin — the same on all three platforms.
    out_dir = os.path.join(dest, 'app', 'bin')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, target['ffmpeg_name'])

    prebuilt = os.environ.get('FFMPEG_PREBUILT')
    if prebuilt:
        shutil.copy2(prebuilt, out)
    elif plat == 'macos':
        # No LGPL prebuild exists for macOS, so it is compiled — which also
        # keeps it to a few megabytes rather than eighty.
        script = os.path.join(ROOT, 'packaging', 'macos', 'build_ffmpeg.sh')
        subprocess.run(['bash', script, out], check=True)
    else:
        url = os.environ.get('FFMPEG_URL') or resolve_btbn_url(target['btbn_match'])
        blob = fetch(url)
        _extract_ffmpeg(blob, url, out, target['ffmpeg_name'])

    os.chmod(out, os.stat(out).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    write_ffmpeg_licence(out_dir)
    return out


def write_ffmpeg_licence(out_dir):
    """
    Ship ffmpeg's licence alongside its binary.

    The LGPL requires the licence text to accompany the binary and the
    corresponding source to be obtainable — a link is not enough for the licence
    itself. It costs 26 KB, so there is no reason to be clever about it.
    """
    licence = fetch('https://raw.githubusercontent.com/FFmpeg/FFmpeg/'
                    f'n{FFMPEG_VERSION}/COPYING.LGPLv2.1')
    with open(os.path.join(out_dir, 'COPYING.LGPLv2.1'), 'wb') as fh:
        fh.write(licence)
    with open(os.path.join(out_dir, 'FFMPEG-NOTICE.txt'), 'w', encoding='utf-8') as fh:
        fh.write(f"""\
This application bundles ffmpeg {FFMPEG_VERSION}, used only to encode the
ProRes 4444 alpha export. It is licensed under the GNU Lesser General Public
License version 2.1 or later; the full text is in COPYING.LGPLv2.1 beside this
file.

ffmpeg is a separate program invoked as a subprocess. It is not linked into the
application, and no part of the application is derived from it.

The corresponding source is the unmodified official release:

    https://ffmpeg.org/releases/ffmpeg-{FFMPEG_VERSION}.tar.xz

No GPL components are enabled. The macOS build is compiled from that source with
the configure flags in packaging/macos/build_ffmpeg.sh; the Windows and Linux
builds are the LGPL builds published at https://github.com/BtbN/FFmpeg-Builds.
""")


def _extract_ffmpeg(blob, url, out, exe_name):
    """Pull just the ffmpeg executable out of a BtbN archive."""
    if url.endswith('.zip'):
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            member = next(n for n in zf.namelist() if n.endswith('/bin/' + exe_name))
            with zf.open(member) as src, open(out, 'wb') as dst:
                shutil.copyfileobj(src, dst)
        return
    with tarfile.open(fileobj=io.BytesIO(blob), mode='r:xz') as tf:
        member = next(m for m in tf.getmembers()
                      if m.name.endswith('/bin/' + exe_name))
        src = tf.extractfile(member)
        with open(out, 'wb') as dst:
            shutil.copyfileobj(src, dst)


def stage_app(dest):
    app_dir = os.path.join(dest, 'app')
    os.makedirs(app_dir, exist_ok=True)
    for name in APP_FILES:
        shutil.copy2(os.path.join(ROOT, name), os.path.join(app_dir, name))
    for name in APP_DIRS:
        shutil.copytree(os.path.join(ROOT, name), os.path.join(app_dir, name),
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    # The marker bootstrap.is_bundled() looks for. Everything that separates an
    # installed copy from a source checkout keys off this one file.
    with open(os.path.join(app_dir, '.bundled'), 'w', encoding='utf-8') as fh:
        fh.write(version.__version__ + '\n')
    log(f'Staged {len(APP_FILES)} files and {len(APP_DIRS)} directories')


def write_manifest(dest, plat, python_url):
    """Record what went in, so a release can be rebuilt or audited later."""
    manifest = {
        'version': version.__version__,
        'platform': plat,
        'python': python_url,
        'python_minor': PYTHON_MINOR,
        'built_on': platform.platform(),
    }
    with open(os.path.join(dest, 'MANIFEST.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
    return manifest


def build(dest, plat):
    target = TARGETS[plat]
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)

    stage_app(dest)
    python_url = install_python(dest, target['triple'])
    seed_requirements(dest, target)
    install_ffmpeg(dest, target, plat)
    manifest = write_manifest(dest, plat, python_url)

    log(f'Payload for {plat} v{manifest["version"]} ready at {dest}')
    return manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dest', required=True, help='staging directory to build into')
    ap.add_argument('--platform', default=host_platform(), choices=sorted(TARGETS))
    args = ap.parse_args()
    build(os.path.abspath(args.dest), args.platform)


if __name__ == '__main__':
    main()
