#!/usr/bin/env bash
#
# Build the small LGPL ffmpeg that ships inside the macOS app.
#
# No LGPL prebuild exists for macOS, and the GPL ones that do would put their
# licence on anything distributed with them. Compiling is cheap here because the
# app needs a very narrow slice of ffmpeg: read a PNG sequence, encode
# prores_ks, write a mov. Everything else is switched off, which takes the
# binary from about 80 MB to about 3 MB and takes a couple of minutes.
#
# Keep the enabled components in step with the command in app.py
# (export_alpha_finish); if that command grows an option, the build needs the
# matching component or the export fails at run time rather than at build time.
#
# Usage: build_ffmpeg.sh <output-path>

set -euo pipefail

OUT="${1:?usage: build_ffmpeg.sh <output-path>}"
FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[ffmpeg] building $FFMPEG_VERSION for $(uname -m)"

curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  -o "$WORK/ffmpeg.tar.xz"
tar -xf "$WORK/ffmpeg.tar.xz" -C "$WORK"
cd "$WORK/ffmpeg-${FFMPEG_VERSION}"

./configure \
  --prefix="$WORK/out" \
  --disable-everything \
  --disable-gpl --disable-nonfree \
  --disable-doc --disable-network --disable-autodetect \
  --disable-ffplay --disable-ffprobe \
  --disable-debug \
  --enable-small \
  --enable-zlib \
  --enable-protocol=file \
  --enable-demuxer=image2 \
  --enable-parser=png \
  --enable-decoder=png \
  --enable-encoder=prores_ks \
  --enable-muxer=mov \
  --enable-filter=null,copy,format,scale

make -j"$(sysctl -n hw.ncpu)"

cp ffmpeg "$OUT"
strip -S "$OUT" 2>/dev/null || true

# Every Mach-O binary on Apple Silicon must carry at least an ad-hoc signature
# or the kernel refuses to execute it. This is free and unrelated to Developer
# ID signing; without it the app installs and then cannot export.
codesign --force --sign - "$OUT"

echo "[ffmpeg] $(du -h "$OUT" | cut -f1) at $OUT"

# Confirm the components the export actually uses survived the trimming.
"$OUT" -hide_banner -encoders 2>/dev/null | grep -q prores_ks \
  || { echo "[ffmpeg] prores_ks encoder missing from the build" >&2; exit 1; }
"$OUT" -hide_banner -muxers 2>/dev/null | grep -q ' mov' \
  || { echo "[ffmpeg] mov muxer missing from the build" >&2; exit 1; }
