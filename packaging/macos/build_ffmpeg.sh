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
  --enable-filter=null,copy,format,scale \
  --enable-videotoolbox \
  --enable-encoder=h264_videotoolbox,aac \
  --enable-muxer=mp4 \
  --enable-protocol=pipe \
  --enable-demuxer=mov,matroska,avi,mpegts,mxf,mp3,wav,flac,aac,ogg \
  --enable-parser=h264,hevc,aac,mpegaudio,vp9,mpeg4video,flac \
  --enable-decoder=h264,hevc,prores,mpeg4,vp9,mjpeg,aac,aac_latm,alac,mp3,flac,vorbis,opus,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le \
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata \
  --enable-filter=overlay,pad,fps,setsar,aresample,aformat,anull

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
# The review copy (H.264 .mp4 with burned-in captions) uses VideoToolbox rather
# than libx264, which is GPL and would change the licence of the shipped app.
"$OUT" -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox \
  || { echo "[ffmpeg] h264_videotoolbox encoder missing from the build" >&2; exit 1; }
"$OUT" -hide_banner -filters 2>/dev/null | grep -q ' overlay ' \
  || { echo "[ffmpeg] overlay filter missing from the build" >&2; exit 1; }
