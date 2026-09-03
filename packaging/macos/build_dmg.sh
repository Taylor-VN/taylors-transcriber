#!/usr/bin/env bash
#
# Build Taylor's Transcriber.app and wrap it in a drag-to-install DMG.
#
# The bundle is a plain app directory around the payload: a shell script as the
# bundle executable, the interpreter and sources in Resources. There is no
# freezing step, because the Settings panel installs speech runtimes with pip at
# run time and needs a real interpreter to do it — see packaging/build_payload.py.
#
# Usage: packaging/macos/build_dmg.sh [output-directory]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-$ROOT/dist}"
BUILD="$ROOT/build"
APP_NAME="Taylor's Transcriber"
VERSION="$(cd "$ROOT" && python3 -c 'import version; print(version.__version__)')"
APP="$BUILD/$APP_NAME.app"
DMG="$OUT_DIR/TaylorsTranscriber-$VERSION-arm64.dmg"

echo "[macos] building $APP_NAME $VERSION"
rm -rf "$BUILD/$APP_NAME.app" "$BUILD/dmgroot"
mkdir -p "$OUT_DIR" "$BUILD"

python3 "$ROOT/packaging/build_payload.py" --platform macos --dest "$BUILD/payload"
python3 "$ROOT/packaging/make_icons.py" --dest "$BUILD/icons"

# ---------------------------------------------------------------------------
# Assemble the bundle
# ---------------------------------------------------------------------------
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -R "$BUILD/payload/python" "$APP/Contents/Resources/python"
cp -R "$BUILD/payload/app" "$APP/Contents/Resources/app"
cp "$BUILD/icons/icon.icns" "$APP/Contents/Resources/icon.icns"

# A shell script is a perfectly good CFBundleExecutable and, unlike a .command
# file, opens no terminal window. Output goes to a log rather than nowhere, so a
# launch failure in an app with no console is still diagnosable.
cat > "$APP/Contents/MacOS/TaylorsTranscriber" <<'LAUNCHER'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
LOG="$HOME/Library/Logs/TaylorsTranscriber.log"
mkdir -p "$(dirname "$LOG")"
exec "$RES/python/bin/python3" "$RES/app/app.py" "$@" >>"$LOG" 2>&1
LAUNCHER
chmod +x "$APP/Contents/MacOS/TaylorsTranscriber"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.taylorvn.transcriber</string>
  <key>CFBundleExecutable</key><string>TaylorsTranscriber</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# ---------------------------------------------------------------------------
# Sign
# ---------------------------------------------------------------------------
# Apple Silicon will not execute an unsigned Mach-O at all, so even an unsigned
# release has to carry ad-hoc signatures. This is not Developer ID signing and
# does nothing for Gatekeeper — it is what makes the binaries runnable.
#
# Set MACOS_SIGN_IDENTITY to a "Developer ID Application: …" identity to sign
# properly instead; the workflow then notarises. Signing runs inside-out
# because a nested binary signed after its container invalidates the container.
IDENTITY="${MACOS_SIGN_IDENTITY:--}"
echo "[macos] signing with identity: $IDENTITY"

find "$APP" -type f \( -name '*.dylib' -o -name '*.so' \) -print0 |
  xargs -0 -I{} codesign --force --timestamp=none --sign "$IDENTITY" {} 2>/dev/null || true
codesign --force --sign "$IDENTITY" "$APP/Contents/Resources/python/bin/python3"* 2>/dev/null || true
codesign --force --sign "$IDENTITY" "$APP/Contents/Resources/app/bin/ffmpeg"

if [ "$IDENTITY" = "-" ]; then
  codesign --force --deep --sign - "$APP"
else
  # A real identity needs the hardened runtime for notarisation to pass, and
  # the interpreter needs these entitlements to keep working under it.
  codesign --force --options runtime --timestamp \
    --entitlements "$ROOT/packaging/macos/entitlements.plist" \
    --sign "$IDENTITY" "$APP"
fi

codesign --verify --strict "$APP" && echo "[macos] signature verifies"

# ---------------------------------------------------------------------------
# DMG
# ---------------------------------------------------------------------------
mkdir -p "$BUILD/dmgroot"
cp -R "$APP" "$BUILD/dmgroot/"
ln -s /Applications "$BUILD/dmgroot/Applications"

rm -f "$DMG"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$BUILD/dmgroot" \
  -fs HFS+ -format UDZO -ov \
  "$DMG" >/dev/null

echo "[macos] $(du -h "$DMG" | cut -f1) → $DMG"
