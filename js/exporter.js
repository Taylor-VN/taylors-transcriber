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
  async ensureFontsReady(presets) {
    if (!document.fonts) return { ready: true, missing: [] };
    try {
      // drawSubtitleFrame prefers the PostScript face an imported Premiere
      // style names, so that is the one the export has to have loaded — for
      // the ratio's style and for every caption that picks its own face.
      const faces = new Map();
      (Array.isArray(presets) ? presets : [presets]).forEach(p => {
        const family = p && (p.fontPostScriptName || p.fontFamily);
        if (!family) return;
        const weight = p.fontWeightBold ? 'bold ' : 'normal ';
        const style = p.fontStyleItalic ? 'italic ' : '';
        faces.set(`${style}${weight}${family}`, { family, spec: `${style}${weight}64px "${family}"` });
      });
      for (const face of faces.values()) await document.fonts.load(face.spec);
      await document.fonts.ready;
      const missing = Array.from(new Set(Array.from(faces.values())
        .map(f => f.family)
        .filter(family => !document.fonts.check(`64px "${family}"`))));
      return { ready: missing.length === 0, missing };
    } catch (e) {
      return { ready: true, missing: [] };
    }
  }

  async export(opts = {}) {
    this.cancelled = false;

    const base = this.player.activePreset;
    const fontState = await this.ensureFontsReady([base].concat(
      this.subManager.getSubtitles().filter(sub => sub.style || sub.speaker)
        .map(sub => this.subManager.styleFor(sub, base))));
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
    let framesWritten = 0;

    // Captions hold for seconds at a time, so most frames repeat the one
    // before. drawSubtitleFrame reports what it drew; only frames that differ
    // are PNG-encoded and sent, and every repeat becomes a hard link on the
    // backend, sent in one batch at the end as [source, first, count] runs.
    const runs = [];
    let prevSig;          // undefined until the first frame is drawn
    let lastUnique = -1;
    let blankIndex = -1;  // first fully transparent frame, reused for every gap
    const sameSig = (a, b) => a === b || (!!a && !!b && a.sub === b.sub &&
      a.alpha === b.alpha && a.scale === b.scale && a.word === b.word);
    const addRepeat = (src, i) => {
      const run = runs[runs.length - 1];
      if (run && run[0] === src && run[1] + run[2] === i) run[2]++;
      else runs.push([src, i, 1]);
    };

    // Encodes run asynchronously and overlap the drawing of the next frames;
    // a small cap keeps memory flat on long 4K renders.
    const inFlight = new Set();
    const MAX_IN_FLIGHT = 4;
    let failure = null;
    const send = (i, blobPromise) => {
      const p = (async () => {
        const blob = await blobPromise;
        if (native) {
          const b64 = await this.blobToBase64(blob);
          const res = await window.pywebview.api.write_frame(jobId, i, b64);
          if (!res || !res.ok) throw new Error((res && res.error) || 'Failed writing frame ' + i);
        } else {
          zipFiles[i].data = new Uint8Array(await blob.arrayBuffer());
        }
      })();
      inFlight.add(p);
      p.catch(e => { failure = failure || e; }).finally(() => inFlight.delete(p));
      return p;
    };
    const pending = [];

    try {
      // WKWebView only finds fonts installed for the user (~/Library/Fonts) from
      // a canvas in the document. A detached one quietly draws the fallback, so
      // any face not registered through FontFace would differ from the preview.
      canvas.style.display = 'none';
      document.body.appendChild(canvas);

      let lastYield = performance.now();
      for (let i = 0; i < totalFrames; i++) {
        if (this.cancelled) throw new Error('Export cancelled.');
        if (failure) throw failure;

        const t = (startFrame + i) / fps;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const sig = this.player.drawSubtitleFrame(ctx, t, project, this.player.activePreset);

        if (i > 0 && sameSig(sig, prevSig)) {
          addRepeat(lastUnique, i);
          if (!native) zipFiles.push(zipFiles[lastUnique]);
        } else if (!sig && blankIndex >= 0) {
          addRepeat(blankIndex, i);
          lastUnique = blankIndex;
          if (!native) zipFiles.push(zipFiles[blankIndex]);
        } else {
          if (!native) zipFiles.push({ name: '', data: null });
          while (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
          // toBlob snapshots the canvas when called, so drawing can move on.
          pending.push(send(i, this.canvasToBlob(canvas)));
          lastUnique = i;
          if (!sig) blankIndex = i;
        }
        prevSig = sig;
        framesWritten++;

        const now = performance.now();
        if (now - lastYield > 100 || i === totalFrames - 1) {
          if (opts.onProgress) opts.onProgress(i + 1, totalFrames, 'Rendering frames');
          // Yield so the progress UI can repaint and the window stays responsive.
          await new Promise(r => setTimeout(r, 0));
          lastYield = performance.now();
        }
      }
      await Promise.all(pending);

      if (native && runs.length) {
        const res = await window.pywebview.api.link_frames(jobId, runs);
        if (!res || !res.ok) throw new Error((res && res.error) || 'Failed writing repeated frames.');
      }

      if (native && opts.review) {
        // Review copy: the frames above are only the caption layer; ffmpeg lays
        // them over the source footage. The offset is the frame-aligned start,
        // not startSec, so captions stay locked to the picture they were timed on.
        if (opts.onProgress) opts.onProgress(totalFrames, totalFrames, 'Compositing H.264 review copy (this can take a while)');
        const res = await window.pywebview.api.encode_review(jobId, {
          fps: fps,
          width: project.width,
          height: project.height,
          scale: opts.review.scale || 1,
          source_path: opts.review.sourcePath,
          start: startFrame / fps,
          duration: totalFrames / fps,
          filename: opts.filename || 'review_copy.mp4'
        });
        if (!res || !res.ok) throw new Error((res && res.error) || 'ffmpeg encoding failed.');
        return { mode: 'review', path: res.path, frames: framesWritten, encoder: res.encoder };
      }

      if (native) {
        if (opts.onProgress) opts.onProgress(totalFrames, totalFrames, 'Encoding ProRes 4444 (this can take a moment)');
        // Fractional rates go to ffmpeg as a ratio (24000/1001), never a rounded
        // decimal, and the .mov is stamped with the timecode of its first frame:
        // the project start plus however far into the timeline the render began.
        const sm = this.subManager;
        const res = await window.pywebview.api.encode_prores(jobId, {
          fps: fps,
          fps_ratio: `${sm.rate.num}/${sm.rate.den}`,
          timecode: sm.framesToTimecode(startFrame + sm.startFrames),
          profile: profile,
          filename: opts.filename || 'subtitles_alpha.mov'
        });
        if (!res || !res.ok) throw new Error((res && res.error) || 'ffmpeg encoding failed.');
        return { mode: 'prores', path: res.path, frames: framesWritten };
      }

      if (opts.onProgress) opts.onProgress(totalFrames, totalFrames, 'Packaging PNG sequence');
      // Repeats share their source's bytes; each still needs its own name.
      const named = zipFiles.map((f, i) => ({ name: `frame_${String(i).padStart(6, '0')}.png`, data: f.data }));
      named.push({
        name: 'ENCODE_TO_PRORES.txt',
        data: new TextEncoder().encode(this.buildFfmpegReadme(fps, profile, project))
      });
      const zipBlob = this.buildZip(named);
      this.downloadBlob(zipBlob, (opts.filename || 'subtitles_alpha').replace(/\.mov$/i, '') + '_png_sequence.zip');
      return { mode: 'png-sequence', frames: framesWritten };
    } finally {
      canvas.remove();
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
      `Frame rate : ${this.subManager.rate.label} fps (${this.subManager.rate.num}/${this.subManager.rate.den})`,
      '',
      'Every PNG is fully transparent except where a caption is drawn, so the',
      'sequence drops straight onto a track above your footage in Premiere Pro.',
      '',
      `To encode it to Apple ProRes ${profileName} with a real alpha channel, run:`,
      '',
      `  ffmpeg -framerate ${this.subManager.rate.num}/${this.subManager.rate.den} -i frame_%06d.png \\`,
      `         -c:v prores_ks -profile:v ${profile} -pix_fmt yuva444p10le \\`,
      '         -alpha_bits 16 -vendor apl0 subtitles_alpha.mov',
      '',
      'Import the resulting .mov into Premiere Pro and place it on a video track',
      'above your footage — the alpha channel is interpreted automatically.',
      ''
    ].join('\n');
  }

  /** toBlob encodes off the main thread, unlike the synchronous toDataURL. */
  canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode frame.'))), 'image/png');
    });
  }

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error || new Error('Could not read frame.'));
      reader.readAsDataURL(blob);
    });
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
