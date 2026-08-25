/**
 * Alpha Export Engine
 *
 * Renders the caption overlay (and nothing else) onto a fully transparent
 * canvas at the project resolution, one frame per timeline frame, then either:
 *
 *   1. Hands the frames to the Python backend, which pipes them into ffmpeg and
 *      encodes Apple ProRes 4444 with a real alpha channel (yuva444p10le), or
 *   2. Falls back to a ZIP'd PNG sequence plus the exact ffmpeg command needed
 *      to turn it into ProRes, for when no backend/ffmpeg is available.
 *
 * The same drawSubtitleFrame() used by the Program Monitor draws the export, so
 * the render is guaranteed to match the preview.
 */

class AlphaExporter {
  constructor(playerController, subtitleManager, fps = 25) {
    this.player = playerController;
    this.subManager = subtitleManager;
    this.fps = fps;
    this.cancelled = false;
  }

  hasNativeBackend() {
    return !!(window.pywebview && window.pywebview.api && window.pywebview.api.begin_export);
  }

  /** Returns { start, end } covering all captions, clamped to the media. */
  getCaptionRange() {
    const subs = this.subManager.getSubtitles();
    if (subs.length === 0) return { start: 0, end: 0 };
    const start = Math.min(...subs.map(s => s.start));
    const end = Math.max(...subs.map(s => s.end));
    return { start: Math.max(0, start), end };
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * @param {Object} opts
   *   rangeMode  'captions' | 'full'
   *   profile    ffmpeg prores_ks profile number (4 = 4444, 5 = 4444 XQ)
   *   padStart   seconds of transparent handle before the first caption
   *   onProgress (done, total, phase) => void
   */
  /**
   * Web fonts load asynchronously. Rendering before they arrive silently falls
   * back to a system font, which would make the export differ from the preview,
   * so always settle the font set first.
   */
  async ensureFontsReady(preset) {
    if (!document.fonts) return { ready: true, missing: [] };
    try {
      // drawSubtitleFrame prefers the PostScript face an imported Premiere
      // style names, so that is the one the export has to have loaded.
      const family = preset && (preset.fontPostScriptName || preset.fontFamily);
      if (family) {
        const weight = preset.fontWeightBold ? 'bold ' : 'normal ';
        const style = preset.fontStyleItalic ? 'italic ' : '';
        await document.fonts.load(`${style}${weight}64px "${family}"`);
      }
      await document.fonts.ready;
      const missing = (family && !document.fonts.check(`64px "${family}"`)) ? [family] : [];
      return { ready: missing.length === 0, missing };
    } catch (e) {
      return { ready: true, missing: [] };
    }
  }

  async export(opts = {}) {
    this.cancelled = false;

    const fontState = await this.ensureFontsReady(this.player.activePreset);
    if (!fontState.ready && opts.onFontWarning) opts.onFontWarning(fontState.missing);

    const project = this.player.project;
    const fps = this.fps;
    const profile = opts.profile !== undefined ? opts.profile : 4;
    const padStart = opts.padStart || 0;

    let startSec = 0;
    let endSec;
    if (opts.rangeMode === 'captions') {
      const range = this.getCaptionRange();
      if (range.end <= range.start) throw new Error('There are no captions to export.');
      startSec = Math.max(0, range.start - padStart);
      endSec = range.end + padStart;
    } else {
      endSec = this.player.getDuration();
      const range = this.getCaptionRange();
      if (range.end > endSec) endSec = range.end;
    }

    if (!(endSec > startSec)) throw new Error('Nothing to export — the export range is empty.');

    const startFrame = Math.floor(startSec * fps);
    const endFrame = Math.ceil(endSec * fps);
    const totalFrames = endFrame - startFrame;

    if (totalFrames <= 0) throw new Error('Nothing to export — the export range is empty.');

    // Offscreen render target at true project resolution, alpha preserved.
    const canvas = document.createElement('canvas');
    canvas.width = project.width;
    canvas.height = project.height;
    const ctx = canvas.getContext('2d', { alpha: true });

    const native = this.hasNativeBackend();
    let jobId = null;

    if (native) {
      const res = await window.pywebview.api.begin_export({
        width: project.width,
        height: project.height,
        fps: fps,
        total_frames: totalFrames
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start the native export job.');
      jobId = res.job_id;
    }

    const zipFiles = [];
    let previousPng = null;
    let framesWritten = 0;

    try {
      for (let i = 0; i < totalFrames; i++) {
        if (this.cancelled) throw new Error('Export cancelled.');

        const t = (startFrame + i) / fps;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        this.player.drawSubtitleFrame(ctx, t, project, this.player.activePreset);

        const dataUrl = canvas.toDataURL('image/png');
        const isRepeat = dataUrl === previousPng;

        if (native) {
          let res;
          if (isRepeat && i > 0) {
            res = await window.pywebview.api.repeat_frame(jobId, i);
          } else {
            res = await window.pywebview.api.write_frame(jobId, i, dataUrl.split(',')[1]);
          }
          if (!res || !res.ok) throw new Error((res && res.error) || 'Failed writing frame ' + i);
        } else {
          const bytes = isRepeat && zipFiles.length
            ? zipFiles[zipFiles.length - 1].data
            : this.base64ToBytes(dataUrl.split(',')[1]);
          zipFiles.push({ name: `frame_${String(i).padStart(6, '0')}.png`, data: bytes });
        }

        previousPng = dataUrl;
        framesWritten++;

        if (opts.onProgress && (i % 5 === 0 || i === totalFrames - 1)) {
          opts.onProgress(i + 1, totalFrames, 'Rendering frames');
        }
        // Yield so the progress UI can repaint and the window stays responsive.
        if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
      }

      if (native) {
        if (opts.onProgress) opts.onProgress(totalFrames, totalFrames, 'Encoding ProRes 4444 (this can take a moment)');
        const res = await window.pywebview.api.encode_prores(jobId, {
          fps: fps,
          profile: profile,
          filename: opts.filename || 'subtitles_alpha.mov'
        });
        if (!res || !res.ok) throw new Error((res && res.error) || 'ffmpeg encoding failed.');
        return { mode: 'prores', path: res.path, frames: framesWritten };
      }

      if (opts.onProgress) opts.onProgress(totalFrames, totalFrames, 'Packaging PNG sequence');
      zipFiles.push({
        name: 'ENCODE_TO_PRORES.txt',
        data: new TextEncoder().encode(this.buildFfmpegReadme(fps, profile, project))
      });
      const zipBlob = this.buildZip(zipFiles);
      this.downloadBlob(zipBlob, (opts.filename || 'subtitles_alpha').replace(/\.mov$/i, '') + '_png_sequence.zip');
      return { mode: 'png-sequence', frames: framesWritten };
    } finally {
      if (native && jobId) {
        try { await window.pywebview.api.cleanup_export(jobId); } catch (e) { /* best effort */ }
      }
    }
  }

  buildFfmpegReadme(fps, profile, project) {
    const profileName = profile === 5 ? '4444 XQ' : '4444';
    return [
      "Alpha subtitle PNG sequence exported from Taylor's Transcriber",
      '==============================================================',
      '',
      `Resolution : ${project.width}x${project.height} (${project.label})`,
      `Frame rate : ${fps} fps`,
      '',
      'Every PNG is fully transparent except where a caption is drawn, so the',
      'sequence drops straight onto a track above your footage in Premiere Pro.',
      '',
      `To encode it to Apple ProRes ${profileName} with a real alpha channel, run:`,
      '',
      `  ffmpeg -framerate ${fps} -i frame_%06d.png \\`,
      `         -c:v prores_ks -profile:v ${profile} -pix_fmt yuva444p10le \\`,
      '         -alpha_bits 16 -vendor apl0 subtitles_alpha.mov',
      '',
      'Import the resulting .mov into Premiere Pro and place it on a video track',
      'above your footage — the alpha channel is interpreted automatically.',
      ''
    ].join('\n');
  }

  base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // --- Minimal ZIP writer (stored / no compression; PNGs are already deflated) ---
  buildZip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;

    const encoder = new TextEncoder();

    files.forEach(file => {
      const nameBytes = encoder.encode(file.name);
      const crc = this.crc32(file.data);
      const size = file.data.length;

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);   // local file header signature
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0, true);            // flags
      lv.setUint16(8, 0, true);            // method: stored
      lv.setUint16(10, 0, true);           // mod time
      lv.setUint16(12, 0, true);           // mod date
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);        // compressed size
      lv.setUint32(22, size, true);        // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // extra length
      localHeader.set(nameBytes, 30);

      chunks.push(localHeader, file.data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);   // central directory signature
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);      // local header offset
      centralHeader.set(nameBytes, 46);
      central.push(centralHeader);

      offset += localHeader.length + size;
    });

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);     // end of central directory
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([...chunks, ...central, end], { type: 'application/zip' });
  }

  crc32(bytes) {
    if (!AlphaExporter._crcTable) {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
      AlphaExporter._crcTable = table;
    }
    const table = AlphaExporter._crcTable;
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

window.AlphaExporter = AlphaExporter;
