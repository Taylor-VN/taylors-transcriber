#!/usr/bin/env bash
#
# Build the Linux AppImage. Intended to run *inside* the manylinux_2_28
# container — see build_in_docker.sh.
#
# Why a container rather than the Ubuntu runner: an AppImage runs against the
# host's glibc, so it can only be built on something at least as old as the
# oldest target. Rocky Linux 9 has glibc 2.34 and Rocky 8 has 2.28, both older
# than Ubuntu 22.04's 2.35 — building on the runner directly would produce a
# binary that refuses to start on exactly the distributions this is for.
# manylinux_2_28 is RHEL 8 based, so anything built here runs on Rocky 8 and 9,
# RHEL, Fedora and Ubuntu 20.04 upwards.
#
# The window comes from Qt, which pip installs complete with its own WebEngine,
# because there is no system GTK/WebKit stack that can be relied on across
# distributions. If Qt will not start — a headless or minimal host — app.py
# already falls back to serving the interface to the user's browser, so the
# AppImage still works rather than dying.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-$ROOT/dist}"
BUILD="$ROOT/build"
APPDIR="$BUILD/AppDir"

PYTHON="${HOST_PYTHON:-python3}"
VERSION="$(cd "$ROOT" && "$PYTHON" -c 'import version; print(version.__version__)')"
OUT="$OUT_DIR/TaylorsTranscriber-$VERSION-x86_64.AppImage"

echo "[linux] building Taylor's Transcriber $VERSION on $(. /etc/os-release && echo "$PRETTY_NAME")"
rm -rf "$APPDIR"
mkdir -p "$OUT_DIR" "$APPDIR/usr"

"$PYTHON" "$ROOT/packaging/build_payload.py" --platform linux --dest "$BUILD/payload"
"$PYTHON" "$ROOT/packaging/make_icons.py" --dest "$BUILD/icons"

cp -R "$BUILD/payload/python" "$APPDIR/usr/python"
cp -R "$BUILD/payload/app" "$APPDIR/usr/app"
cp "$BUILD/icons/icon.png" "$APPDIR/taylors-transcriber.png"

cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
#
# The AppImage installs itself on first run, then launches from the installed
# copy. That is not the usual AppImage habit, and it is not decoration.
#
# An AppImage is mounted at a fresh random path — /tmp/.mount_XXXXXX — every
# time it starts. This app keeps a Python environment that it adds speech
# runtimes to, and a virtual environment records the absolute path of the
# interpreter that created it. Run straight from the mount and that path is
# dangling by the next launch, so bootstrap.venv_is_usable() sees a broken
# environment and rebuilds it — deleting several gigabytes of runtimes the user
# installed, every single launch.
#
# Copying to a stable location once fixes it, and gives the app a desktop entry
# into the bargain. The AppImage file can be deleted afterwards.
set -e
HERE="$(dirname "$(readlink -f "$0")")"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
TARGET="$DATA_HOME/taylors-transcriber/app"

launch() {
  exec "$1/usr/python/bin/python3" "$1/usr/app/app.py" "${@:2}"
}

# $APPIMAGE is set by the AppImage runtime and unset in the installed copy, so
# this is what distinguishes "someone double-clicked the download" from "the
# desktop entry started the installed app".
if [ -z "${APPIMAGE:-}" ] || [ "${TT_NO_INSTALL:-}" = "1" ]; then
  launch "$HERE" "$@"
fi

VERSION="$(cat "$HERE/usr/app/.bundled" 2>/dev/null || echo unknown)"
INSTALLED="$(cat "$TARGET/usr/app/.bundled" 2>/dev/null || echo none)"

if [ "$VERSION" != "$INSTALLED" ]; then
  echo "Installing Taylor's Transcriber $VERSION to $TARGET" >&2
  rm -rf "$TARGET.new"
  mkdir -p "$(dirname "$TARGET")"
  cp -a "$HERE" "$TARGET.new"
  # Swap rather than overwrite, so an interrupted copy cannot leave a
  # half-installed app that fails in confusing ways.
  rm -rf "$TARGET.old"
  if [ -d "$TARGET" ]; then mv "$TARGET" "$TARGET.old"; fi
  mv "$TARGET.new" "$TARGET"
  rm -rf "$TARGET.old"

  mkdir -p "$DATA_HOME/applications"
  cat > "$DATA_HOME/applications/taylors-transcriber.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Taylor's Transcriber
Comment=Caption editor with ProRes 4444 alpha export
Exec="$TARGET/AppRun" %f
Icon=$TARGET/taylors-transcriber.png
Categories=AudioVideo;Video;AudioVideoEditing;
Terminal=false
DESKTOP
  update-desktop-database "$DATA_HOME/applications" 2>/dev/null || true
fi

launch "$TARGET" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

# appimagetool requires the desktop file and an icon of a matching name at the
# root of the AppDir; the Icon key is a name, not a path.
cat > "$APPDIR/taylors-transcriber.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Taylor's Transcriber
Comment=Caption editor with ProRes 4444 alpha export
Exec=AppRun %f
Icon=taylors-transcriber
Categories=AudioVideo;Video;AudioVideoEditing;
Terminal=false
DESKTOP

# --appimage-extract-and-run avoids needing FUSE, which containers and many
# locked-down hosts do not provide.
TOOL="$BUILD/appimagetool"
if [ ! -x "$TOOL" ]; then
  curl -fsSL -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$TOOL"
fi

rm -f "$OUT"
ARCH=x86_64 "$TOOL" --appimage-extract-and-run "$APPDIR" "$OUT"
chmod +x "$OUT"

echo "[linux] $(du -h "$OUT" | cut -f1) → $OUT"
