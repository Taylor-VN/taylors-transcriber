/**
 * Caption Formats
 * Broadcast caption interchange: TTML / DFXP (IMSC1 text profile), SCC (CEA-608
 * pop-on) and EBU-STL (Tech 3264). Everything here is a pure function over
 * caption lists so it can be tested without a DOM:
 *
 *   export*(captions, opts) -> string (TTML, SCC) or Uint8Array (STL)
 *   import*(textOrBuffer, opts) -> [{ start, end, text }]  (seconds, start offset removed)
 *
 * `opts` carries the project's clock: { fps, timebase, dropFrame, startOffsetSec }
 * straight off SubtitleManager, plus { lang } and an optional `warnings` array
 * that formats push human-readable problems into (re-wrapped lines, etc.).
 */
const CaptionFormats = (() => {
  // ---- timecode helpers --------------------------------------------------

  /** Real rate, whole-number counting rate and drop count for this project. */
  function clock(opts) {
    const fps = opts && opts.fps > 0 ? opts.fps : 25;
    const nominal = (opts && opts.timebase > 0) ? opts.timebase : Math.round(fps);
    // Drop-frame only exists for 30/60 counting; ignore the flag elsewhere.
    const drop = opts && opts.dropFrame && (nominal === 30 || nominal === 60) ? nominal / 15 : 0;
    return { fps, nominal, drop, offset: (opts && opts.startOffsetSec) || 0 };
  }

  function framesToTc(total, nominal, drop) {
    let f = Math.max(0, Math.round(total));
    if (drop) {
      const perMin = nominal * 60 - drop;          // frames in a minute that dropped numbers
      const per10 = nominal * 600 - drop * 9;      // frames in ten minutes
      const d = Math.floor(f / per10);
      const m = f % per10;
      f += drop * 9 * d;
      if (m >= drop) f += drop * Math.floor((m - drop) / perMin);
    }
    const ff = f % nominal;
    const secs = Math.floor(f / nominal);
    return { h: Math.floor(secs / 3600), m: Math.floor(secs / 60) % 60, s: secs % 60, f: ff };
  }

  function tcToFrames(h, m, s, f, nominal, drop) {
    let total = ((h * 60 + m) * 60 + s) * nominal + f;
    if (drop) {
      const tm = h * 60 + m;
      total -= drop * (tm - Math.floor(tm / 10));
    }
    return total;
  }

  const p2 = (n) => String(n).padStart(2, '0');

  // ---- text helpers ------------------------------------------------------

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function unescapeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
    });
  }

  /** Greedy word wrap; words longer than a row are hard-split. */
  function wrapLine(line, max) {
    const out = [];
    let cur = '';
    for (let word of line.split(/\s+/).filter(Boolean)) {
      while (word.length > max) {
        if (cur) { out.push(cur); cur = ''; }
        out.push(word.slice(0, max));
        word = word.slice(max);
      }
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= max) cur += ' ' + word;
      else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** Keeps the editor's own breaks; only lines that do not fit are re-wrapped. */
  function layoutLines(text, max) {
    const lines = [];
    let wrapped = false;
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line) continue;
      if (line.length <= max) lines.push(line);
      else { lines.push(...wrapLine(line, max)); wrapped = true; }
    }
    return { lines, wrapped };
  }

  function warn(opts, msg) {
    if (opts && Array.isArray(opts.warnings)) opts.warnings.push(msg);
  }

  function sorted(captions) {
    return captions
      .filter(c => c && String(c.text || '').trim() && c.end > c.start - 1e-9)
      .slice().sort((a, b) => a.start - b.start);
  }

  // ======================================================================
  // TTML / DFXP / IMSC1
  // ======================================================================

  function exportTTML(captions, opts = {}) {
    const ck = clock(opts);
    const lang = opts.lang || 'en';
    const mult = Math.abs(ck.fps - ck.nominal) > 1e-6 ? ' ttp:frameRateMultiplier="1000 1001"' : '';
    const dropAttr = ck.drop ? ' ttp:dropMode="dropNTSC"' : '';
    const tc = (sec) => {
      const t = framesToTc((sec + ck.offset) * ck.fps, ck.nominal, ck.drop);
      return `${p2(t.h)}:${p2(t.m)}:${p2(t.s)}:${p2(t.f)}`;
    };
    const list = sorted(captions);
    const ps = list.map((c, i) => {
      let begin = Math.round((c.start + ck.offset) * ck.fps);
      let end = Math.round((c.end + ck.offset) * ck.fps);
      if (end <= begin) end = begin + 1; // a zero-length p is dropped by players
      const body = String(c.text).replace(/\r/g, '').split('\n')
        .map(l => escapeXml(l.trim())).filter(Boolean).join('<br/>');
      return `      <p xml:id="c${i + 1}" region="r1" begin="${tc((begin / ck.fps) - ck.offset)}"`
        + ` end="${tc((end / ck.fps) - ck.offset)}">${body}</p>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    xml:lang="${escapeXml(lang)}"
    ttp:timeBase="smpte" ttp:frameRate="${ck.nominal}"${mult}${dropAttr}
    ttp:contentProfiles="http://www.w3.org/ns/ttml/profile/imsc1/text">
  <head>
    <styling>
      <style xml:id="s1" tts:fontFamily="proportionalSansSerif" tts:fontSize="100%"
             tts:textAlign="center" tts:color="white"/>
    </styling>
    <layout>
      <region xml:id="r1" tts:origin="10% 80%" tts:extent="80% 20%" tts:displayAlign="after"/>
    </layout>
  </head>
  <body style="s1">
    <div>
${ps.join('\n')}
    </div>
  </body>
</tt>
`;
  }

  function xmlAttr(tag, name) {
    const re = new RegExp('(?:^|\\s)(?:[\\w.-]+:)?' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')');
    const m = re.exec(tag);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  }

  function importTTML(xml, opts = {}) {
    xml = String(xml).replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '');
    const root = /<(?:[\w.-]+:)?tt\b[^>]*>/.exec(xml);
    const rootTag = root ? root[0] : '';
    const num = (v, d) => { const n = parseFloat(v); return n > 0 ? n : d; };
    const frameRate = num(xmlAttr(rootTag, 'frameRate'), 30);
    const mm = /^\s*(\d+)\s+(\d+)\s*$/.exec(xmlAttr(rootTag, 'frameRateMultiplier') || '');
    const rate = frameRate * (mm ? mm[1] / mm[2] : 1);
    const subRate = num(xmlAttr(rootTag, 'subFrameRate'), 1);
    const tickRate = num(xmlAttr(rootTag, 'tickRate'),
      xmlAttr(rootTag, 'frameRate') ? frameRate * subRate : 1);
    const smpte = (xmlAttr(rootTag, 'timeBase') || 'media') === 'smpte';
    const dropMode = xmlAttr(rootTag, 'dropMode') || 'nonDrop';
    const nominal = Math.round(frameRate);
    const drop = smpte && /^drop/.test(dropMode) && (nominal === 30 || nominal === 60)
      ? nominal / 15 : 0;
    const offset = typeof opts.startOffsetSec === 'number' ? opts.startOffsetSec : 0;

    const parse = (str) => {
      if (str == null) return NaN;
      str = str.trim();
      let m = /^(\d+):(\d{2}):(\d{2})(?:[.,](\d+)|:(\d+)(?:\.(\d+))?)?$/.exec(str);
      if (m) {
        const h = +m[1], mi = +m[2], s = +m[3];
        if (m[5] !== undefined) {
          const f = +m[5]; // a sub-frame part, if any, is below what we keep
          if (smpte) return tcToFrames(h, mi, s, f, nominal, drop) / rate;
          return h * 3600 + mi * 60 + s + f / rate;
        }
        return h * 3600 + mi * 60 + s + (m[4] ? parseFloat('0.' + m[4]) : 0);
      }
      m = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(str);
      if (m) {
        const v = parseFloat(m[1]);
        return { h: v * 3600, m: v * 60, s: v, ms: v / 1000, f: v / rate, t: v / tickRate }[m[2]];
      }
      return NaN;
    };

    const out = [];
    const re = /<(?:[\w.-]+:)?p\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?p\s*>)/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      let begin = parse(xmlAttr(attrs, 'begin'));
      if (isNaN(begin)) continue;
      let end = parse(xmlAttr(attrs, 'end'));
      const dur = parse(xmlAttr(attrs, 'dur'));
      if (isNaN(end)) end = isNaN(dur) ? begin + 2 : begin + dur;
      const inner = (m[2] || '')
        .replace(/\s+/g, ' ')
        .replace(/<(?:[\w.-]+:)?br\s*\/?\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '');
      const text = unescapeXml(inner).split('\n').map(l => l.trim()).filter(Boolean).join('\n');
      if (!text) continue;
      if (smpte) { begin -= offset; end -= offset; }
      out.push({ start: Math.max(0, begin), end: Math.max(0, end), text });
    }
    return out;
  }

  // ======================================================================
  // SCC (CEA-608, channel 1, pop-on, 29.97 drop-frame)
  // ======================================================================

  const SCC_RATE = 30000 / 1001;
  const SCC_MAX_COLS = 32;
  const SCC_MAX_ROWS = 4;

  /** Odd parity on bit 7: 'H' (0x48, two bits set) -> 0xC8. */
  function oddParity(b) {
    b &= 0x7F;
    let ones = 0;
    for (let v = b; v; v >>= 1) ones += v & 1;
    return ones % 2 === 0 ? (b | 0x80) : b;
  }

  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const sccWord = (a, b) => hex2(oddParity(a)) + hex2(oddParity(b));

  // Basic-set code points that are not ASCII in CEA-608.
  const SCC_BASIC_SUB = {
    0x2A: 'á', 0x5C: 'é', 0x5E: 'í', 0x5F: 'ó', 0x60: 'ú',
    0x7B: 'ç', 0x7C: '÷', 0x7D: 'Ñ', 0x7E: 'ñ', 0x7F: '■'
  };
  const SCC_SPECIAL = '®°½¿™¢£♪à èâêîôû'; // 0x11 0x30..0x3F; 0x39 is a transparent space
  const SCC_EXT1 = 'ÁÉÓÚÜü‘¡*’—©℠•“”ÀÂÇÈÊËëÎÏïÔÙùÛ«»'; // 0x12 0x20..0x3F
  const SCC_EXT2 = 'ÃãÍÌìÒòÕõ{}\\^_|~ÄäÖöß¥¤│ÅåØø┌┐└┘'; // 0x13 0x20..0x3F

  const SCC_ENC = (() => {
    const t = {};
    Object.keys(SCC_BASIC_SUB).forEach(k => { t[SCC_BASIC_SUB[k]] = { kind: 'basic', b: +k }; });
    [...SCC_SPECIAL].forEach((c, i) => { if (c !== ' ') t[c] = { kind: 'special', b1: 0x11, b2: 0x30 + i }; });
    [...SCC_EXT1].forEach((c, i) => { t[c] = { kind: 'ext', b1: 0x12, b2: 0x20 + i }; });
    [...SCC_EXT2].forEach((c, i) => { t[c] = { kind: 'ext', b1: 0x13, b2: 0x20 + i }; });
    return t;
  })();

  function stripDiacritics(c) {
    const d = c.normalize ? c.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : c;
    return /^[A-Za-z0-9]$/.test(d[0] || '') ? d[0] : '?';
  }

  /** Text -> list of tokens: {b} plain byte, or {w:[b1,b2], fb} two-byte code. */
  function sccTokens(text) {
    const src = text.replace(/…/g, '...').replace(/[–]/g, '-').replace(/[\u00A0\t]/g, ' ');
    const toks = [];
    for (const c of src) {
      const e = SCC_ENC[c];
      if (e && e.kind === 'basic') toks.push({ b: e.b });
      else if (e && e.kind === 'special') toks.push({ w: [e.b1, e.b2] });
      else if (e && e.kind === 'ext') toks.push({ w: [e.b1, e.b2], fb: c === '*' ? 0x2D : stripDiacritics(c).charCodeAt(0) });
      else {
        const code = c.charCodeAt(0);
        if (code >= 0x20 && code < 0x7F) toks.push({ b: code });
        else toks.push({ b: stripDiacritics(c).charCodeAt(0) });
      }
    }
    return toks;
  }

  /** Pack tokens into 16-bit words; two-byte codes always start on a word. */
  function sccPack(toks) {
    const words = [];
    let pending = null;
    const flush = () => { if (pending !== null) { words.push(sccWord(pending, 0)); pending = null; } };
    for (const t of toks) {
      if (t.w) {
        if (t.fb !== undefined) {
          // Extended characters overwrite the character before them, so a
          // plain stand-in goes first for decoders that do not know the code.
          if (pending !== null) { words.push(sccWord(pending, t.fb)); pending = null; }
          else words.push(sccWord(t.fb, 0));
        } else flush();
        words.push(sccWord(t.w[0], t.w[1]));
      } else if (pending === null) pending = t.b;
      else { words.push(sccWord(pending, t.b)); pending = null; }
    }
    flush();
    return words;
  }

  const SCC_PAC_ROW = [null, [0x11, 0x40], [0x11, 0x60], [0x12, 0x40], [0x12, 0x60],
    [0x15, 0x40], [0x15, 0x60], [0x16, 0x40], [0x16, 0x60], [0x17, 0x40], [0x17, 0x60],
    [0x10, 0x40], [0x13, 0x40], [0x13, 0x60], [0x14, 0x40], [0x14, 0x60]];

  /** White, indented PAC for a row; indent is rounded down to a multiple of 4. */
  function sccPac(row, indent) {
    const [b1, base] = SCC_PAC_ROW[row];
    return [b1, base | 0x10 | ((Math.floor(indent / 4) & 7) << 1)];
  }

  const dbl = (a, b) => [sccWord(a, b), sccWord(a, b)];

  function sccTimecode(frame) {
    const t = framesToTc(frame, 30, 2);
    return `${p2(t.h)}:${p2(t.m)}:${p2(t.s)};${p2(t.f)}`;
  }

  function exportSCC(captions, opts = {}) {
    const offset = (opts.startOffsetSec) || 0;
    // Break each caption into pop-on screens of at most four rows.
    const screens = [];
    let rewrapped = 0;
    for (const c of sorted(captions)) {
      const { lines, wrapped } = layoutLines(c.text, SCC_MAX_COLS);
      if (!lines.length) continue;
      if (wrapped) rewrapped++;
      const start = c.start + offset, end = Math.max(c.end, c.start) + offset;
      const chunks = [];
      for (let i = 0; i < lines.length; i += SCC_MAX_ROWS) chunks.push(lines.slice(i, i + SCC_MAX_ROWS));
      const weights = chunks.map(ch => ch.join('').length || 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let t = start;
      chunks.forEach((ch, i) => {
        const e = i === chunks.length - 1 ? end : t + (end - start) * weights[i] / total;
        screens.push({ lines: ch, start: t, end: e });
        t = e;
      });
      if (chunks.length > 1) warn(opts, `SCC: a caption with ${lines.length} rows was split into ${chunks.length} screens.`);
    }
    if (rewrapped) warn(opts, `SCC: ${rewrapped} caption${rewrapped === 1 ? ' has' : 's have'} lines over ${SCC_MAX_COLS} characters and ${rewrapped === 1 ? 'was' : 'were'} re-wrapped.`);

    const slots = new Map(); // frame -> word
    const free = (f, n) => { for (let i = 0; i < n; i++) if (f + i < 0 || slots.has(f + i)) return false; return true; };
    const put = (f, words) => words.forEach((w, i) => slots.set(f + i, w));
    let lastEoc = -2;
    let late = 0;

    screens.forEach((s, idx) => {
      const n = s.lines.length;
      const words = [...dbl(0x14, 0x20), ...dbl(0x14, 0x2E)]; // RCL, ENM
      s.lines.forEach((line, i) => {
        const indent = Math.max(0, Math.floor((SCC_MAX_COLS - line.length) / 2));
        const pad = indent % 4;
        words.push(...dbl(...sccPac(16 - n + i, indent - pad)));
        words.push(...sccPack(sccTokens(' '.repeat(pad) + line)));
      });
      const startF = Math.round(s.start * SCC_RATE);
      // Load as late as possible, but never inside a previous screen's own
      // load/EOC, and never on top of an EDM already placed.
      const minStart = lastEoc + 2;
      let loadF = Math.max(minStart, startF - words.length);
      let down = Math.max(minStart, startF - words.length);
      while (down >= minStart && !free(down, words.length)) down--;
      if (down >= minStart) loadF = down;
      else { loadF = Math.max(minStart, startF - words.length); while (!free(loadF, words.length)) loadF++; }
      put(loadF, words);
      let eocF = Math.max(startF, loadF + words.length);
      while (!free(eocF, 2)) eocF++;
      put(eocF, dbl(0x14, 0x2F));
      lastEoc = eocF;
      if (eocF - startF > 3) late++;

      const next = screens[idx + 1];
      const endF = Math.max(Math.round(s.end * SCC_RATE), eocF + 2);
      // A following EOC swaps the screen anyway; a clear in between would
      // only blank a frame or two for nothing.
      const abuts = next && Math.round(next.start * SCC_RATE) <= endF + 1;
      if (!abuts) {
        let edmF = endF;
        while (!free(edmF, 2)) edmF++;
        put(edmF, dbl(0x14, 0x2C));
      }
    });

    // 608 carries one byte pair per frame, so text that is long for its slot
    // (or sits at the very start of the file) cannot be loaded in time.
    if (late) warn(opts, `SCC: ${late} caption${late === 1 ? ' appears' : 's appear'} more than 3 frames late because the 608 data rate could not load ${late === 1 ? 'it' : 'them'} in time.`);

    // Emit runs of consecutive frames as one timestamped line.
    const frames = [...slots.keys()].sort((a, b) => a - b);
    const lines = ['Scenarist_SCC V1.0', ''];
    let run = null;
    const closeRun = () => { if (run) lines.push(`${sccTimecode(run.f)}\t${run.words.join(' ')}`, ''); };
    for (const f of frames) {
      if (run && f === run.f + run.words.length) run.words.push(slots.get(f));
      else { closeRun(); run = { f, words: [slots.get(f)] }; }
    }
    closeRun();
    return lines.join('\n');
  }

  /** Row from a PAC's two bytes (parity already stripped), or 0 if it is not one. */
  function sccPacRow(b1, b2) {
    if (b2 < 0x40 || b2 > 0x7F) return 0;
    const hi = b2 >= 0x60 ? 0x60 : 0x40;
    for (let r = 1; r <= 15; r++) {
      const v = SCC_PAC_ROW[r];
      if (v[0] === b1 && v[1] === hi) return r;
    }
    return 0;
  }

  function importSCC(text, opts = {}) {
    const offset = typeof opts.startOffsetSec === 'number' ? opts.startOffsetSec : 0;
    const out = [];
    let shown = null;      // {start, rows}
    let displayed = new Map(), hidden = new Map();
    let target = hidden;   // pop-on writes to the off-screen buffer
    let row = 15, col = 0;
    let prev = null;       // previous control word, to drop the repeat
    let lastFrame = 0;

    const textOf = (buf) => {
      const rows = [...buf.keys()].sort((a, b) => a - b);
      return rows.map(r => {
        const cells = buf.get(r);
        let s = '';
        for (let i = 0; i < cells.length; i++) s += cells[i] === undefined ? ' ' : cells[i];
        return s.replace(/\s+/g, ' ').trim();
      }).filter(Boolean).join('\n');
    };
    const frameSec = (f) => Math.max(0, f / SCC_RATE - offset);
    const closeShown = (f) => {
      if (shown) {
        const end = frameSec(f);
        if (shown.text && end > shown.start) out.push({ start: shown.start, end, text: shown.text });
        shown = null;
      }
    };
    const put = (ch) => {
      let cells = target.get(row);
      if (!cells) { cells = []; target.set(row, cells); }
      cells[col++] = ch;
    };
    const backspace = () => {
      const cells = target.get(row);
      if (col > 0) { col--; if (cells) cells[col] = undefined; }
    };

    const lineRe = /^\s*(\d+):(\d+):(\d+)([;:.,])(\d+)\s+([0-9a-fA-F\s]+)$/;
    for (const line of String(text).split(/\r?\n/)) {
      const m = lineRe.exec(line);
      if (!m) continue;
      const dropTc = m[4] === ';' || m[4] === '.';
      let frame = tcToFrames(+m[1], +m[2], +m[3], +m[5], 30, dropTc ? 2 : 0);
      prev = null;
      for (const w of m[6].trim().split(/\s+/)) {
        if (w.length !== 4) { frame++; continue; }
        const b1 = parseInt(w.slice(0, 2), 16) & 0x7F;
        const b2 = parseInt(w.slice(2), 16) & 0x7F;
        lastFrame = frame;
        const isCtl = b1 >= 0x10 && b1 <= 0x1F;
        if (isCtl && prev === w.toLowerCase()) { prev = null; frame++; continue; } // doubled control code
        prev = isCtl ? w.toLowerCase() : null;
        if (isCtl) {
          if (b1 >= 0x18) { frame++; continue; } // channel 2 / data channel
          if (b1 === 0x14 && b2 >= 0x20 && b2 <= 0x2F) {
            if (b2 === 0x20) target = hidden;                    // RCL: pop-on
            else if (b2 === 0x21) backspace();                   // BS
            else if (b2 === 0x2C) { closeShown(frame); displayed = new Map(); } // EDM
            else if (b2 === 0x2E) hidden = new Map(), target = target === displayed ? target : hidden; // ENM
            else if (b2 === 0x2F) {                              // EOC: flip memories
              closeShown(frame);
              displayed = hidden; hidden = new Map(); target = hidden;
              const t = textOf(displayed);
              if (t) shown = { start: frameSec(frame), text: t };
            }
          } else if (b1 === 0x11 && b2 >= 0x20 && b2 <= 0x2F) {
            put(' ');                                            // mid-row style code takes a cell
          } else if (b1 === 0x11 && b2 >= 0x30 && b2 <= 0x3F) {
            put(SCC_SPECIAL[b2 - 0x30] === ' ' ? ' ' : SCC_SPECIAL[b2 - 0x30]);
          } else if ((b1 === 0x12 || b1 === 0x13) && b2 >= 0x20 && b2 <= 0x3F) {
            backspace();
            put((b1 === 0x12 ? SCC_EXT1 : SCC_EXT2)[b2 - 0x20]);
          } else if (b1 === 0x17 && b2 >= 0x21 && b2 <= 0x23) {
            col += b2 - 0x20;                                    // tab offset
          } else {
            const r = sccPacRow(b1, b2);
            if (r) {
              row = r;
              col = (b2 & 0x10) ? ((b2 >> 1) & 7) * 4 : 0;
            }
          }
        } else {
          for (const b of [b1, b2]) {
            if (b < 0x20) continue;
            put(SCC_BASIC_SUB[b] || String.fromCharCode(b));
          }
        }
        frame++;
      }
    }
    // A stream that never clears its last caption: hold it a little.
    if (shown) closeShown(lastFrame + Math.round(2 * SCC_RATE));
    return out;
  }

  // ======================================================================
  // EBU-STL (Tech 3264)
  // ======================================================================

  const STL_LANG = { en: '09', de: '08', es: '0A', fr: '0F', it: '15', nl: '1D', no: '1E', nb: '1E',
    pl: '20', pt: '21', fi: '27', sv: '28', tr: '29', da: '07', cs: '06', ca: '03', hr: '04', hu: '1B', ro: '22' };
  const STL_LANG_REV = Object.keys(STL_LANG).reduce((o, k) => { if (!o[STL_LANG[k]]) o[STL_LANG[k]] = k; return o; }, {});

  // Latin table (ISO 6937 flavour): diacritics are a prefix byte before the letter.
  const STL_DIACRITIC = { '\u0300': 0xC1, '\u0301': 0xC2, '\u0302': 0xC3, '\u0303': 0xC4, '\u0304': 0xC5,
    '\u0306': 0xC6, '\u0307': 0xC7, '\u0308': 0xC8, '\u030A': 0xCA, '\u0327': 0xCB, '\u030B': 0xCD,
    '\u0328': 0xCE, '\u030C': 0xCF };
  const STL_DIACRITIC_REV = Object.keys(STL_DIACRITIC).reduce((o, k) => { o[STL_DIACRITIC[k]] = k; return o; }, {});
  const STL_SPECIAL = { 'ß': 0xFB, 'Æ': 0xE1, 'æ': 0xF1, 'Ø': 0xE9, 'ø': 0xF9, 'Œ': 0xEA, 'œ': 0xFA,
    '¿': 0xBF, '¡': 0xA1, '£': 0xA3, '¥': 0xA5, '§': 0xA7, '°': 0xB0, '«': 0xAB, '»': 0xBB,
    '©': 0xD3, '®': 0xD2, '™': 0xD4, '‘': 0xA9, '“': 0xAA, '’': 0xB9, '”': 0xBA, '÷': 0xB8, '×': 0xB4,
    '½': 0xBD, '¼': 0xBC, '¾': 0xBE, '±': 0xB1, '♪': 0xD5 };
  const STL_SPECIAL_REV = Object.keys(STL_SPECIAL).reduce((o, k) => { o[STL_SPECIAL[k]] = k; return o; }, {});

  function stlEncodeText(str) {
    const out = [];
    for (const c of str.replace(/…/g, '...').replace(/[–—]/g, '-').replace(/[\u00A0\t]/g, ' ')) {
      const code = c.charCodeAt(0);
      if (code >= 0x20 && code < 0x7F) { out.push(code); continue; }
      if (STL_SPECIAL[c] !== undefined) { out.push(STL_SPECIAL[c]); continue; }
      const d = c.normalize ? c.normalize('NFD') : c;
      if (d.length === 2 && STL_DIACRITIC[d[1]] !== undefined && d.charCodeAt(0) < 0x7F) {
        out.push(STL_DIACRITIC[d[1]], d.charCodeAt(0));
      } else out.push(d.charCodeAt(0) >= 0x20 && d.charCodeAt(0) < 0x7F ? d.charCodeAt(0) : 0x3F);
    }
    return out;
  }

  function stlDecodeText(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0x8A) s += '\n';
      else if (b === 0x8F) break;
      else if (b < 0x20 || (b >= 0x7F && b < 0xA0)) continue; // teletext control / style codes
      else if (b >= 0xC1 && b <= 0xCF && STL_DIACRITIC_REV[b] && i + 1 < bytes.length) {
        const base = String.fromCharCode(bytes[i + 1]);
        s += (base + STL_DIACRITIC_REV[b]).normalize ? (base + STL_DIACRITIC_REV[b]).normalize('NFC') : base;
        i++;
      } else if (b < 0x7F) s += String.fromCharCode(b);
      else s += STL_SPECIAL_REV[b] || '';
    }
    return s;
  }

  function putAscii(buf, off, len, str) {
    for (let i = 0; i < len; i++) {
      const c = i < str.length ? str.charCodeAt(i) : 0x20;
      buf[off + i] = c >= 0x20 && c < 0x7F ? c : 0x20;
    }
  }

  function exportSTL(captions, opts = {}) {
    const ck = clock(opts);
    const lang = (opts.lang || 'en').toLowerCase().split(/[-_]/)[0];
    const maxChars = 37;
    const list = sorted(captions);
    const ttiBlocks = [];
    let sn = 0, wrapped = 0;
    const tcBytes = (sec) => {
      const t = framesToTc((sec + ck.offset) * ck.fps, ck.nominal, ck.drop);
      return [t.h, t.m, t.s, t.f];
    };
    for (const c of list) {
      const { lines, wrapped: w } = layoutLines(c.text, maxChars);
      if (!lines.length) continue;
      if (w) wrapped++;
      // 0x0B 0x0B opens the subtitle box and 0x0A 0x0A closes it on each row
      // (Teletext level-1 convention); rows are joined with 0x8A.
      const text = [];
      lines.forEach((line, i) => {
        if (i) text.push(0x8A);
        text.push(0x0B, 0x0B, ...stlEncodeText(line), 0x0A, 0x0A);
      });
      const tci = tcBytes(c.start);
      let endSec = c.end;
      if (Math.round((endSec + ck.offset) * ck.fps) <= Math.round((c.start + ck.offset) * ck.fps)) endSec = c.start + 1 / ck.fps;
      const tco = tcBytes(endSec);
      const vp = Math.max(1, 22 - (lines.length - 1));
      const nBlocks = Math.max(1, Math.ceil(text.length / 112));
      sn++;
      for (let b = 0; b < nBlocks; b++) {
        const blk = new Uint8Array(128);
        blk[0] = 0;                                   // SGN
        blk[1] = sn & 0xFF; blk[2] = (sn >> 8) & 0xFF; // SN little endian
        blk[3] = b === nBlocks - 1 ? 0xFF : b;        // EBN
        blk[4] = 0;                                   // CS
        blk.set(tci, 5); blk.set(tco, 9);
        blk[13] = vp; blk[14] = 2; blk[15] = 0;       // VP, JC centre, CF
        blk.fill(0x8F, 16);
        blk.set(text.slice(b * 112, (b + 1) * 112), 16);
        ttiBlocks.push(blk);
      }
    }
    if (wrapped) warn(opts, `STL: ${wrapped} caption${wrapped === 1 ? ' has' : 's have'} lines over ${maxChars} characters and ${wrapped === 1 ? 'was' : 'were'} re-wrapped.`);

    const gsi = new Uint8Array(1024);
    gsi.fill(0x20);
    putAscii(gsi, 0, 3, '850');
    putAscii(gsi, 3, 8, ck.nominal === 25 ? 'STL25.01' : 'STL30.01');
    putAscii(gsi, 11, 1, '1');                        // DSC: level-1 teletext
    putAscii(gsi, 12, 2, '00');                       // CCT: Latin
    putAscii(gsi, 14, 2, STL_LANG[lang] || '00');
    putAscii(gsi, 16, 32, opts.title || '');
    const d = new Date();
    const ymd = String(d.getFullYear() % 100).padStart(2, '0') + p2(d.getMonth() + 1) + p2(d.getDate());
    putAscii(gsi, 224, 6, ymd);                       // CD
    putAscii(gsi, 230, 6, ymd);                       // RD
    putAscii(gsi, 236, 2, '00');                      // RN
    putAscii(gsi, 238, 5, String(ttiBlocks.length).padStart(5, '0'));  // TNB
    putAscii(gsi, 243, 5, String(sn).padStart(5, '0'));                // TNS
    putAscii(gsi, 248, 3, '001');                     // TNG
    putAscii(gsi, 251, 2, String(maxChars));          // MNC
    putAscii(gsi, 253, 2, '11');                      // MNR
    putAscii(gsi, 255, 1, '1');                       // TCS
    const t0 = framesToTc(ck.offset * ck.fps, ck.nominal, ck.drop);
    putAscii(gsi, 256, 8, p2(t0.h) + p2(t0.m) + p2(t0.s) + p2(t0.f));  // TCP
    const first = list.length ? tcBytes(list[0].start) : [t0.h, t0.m, t0.s, t0.f];
    putAscii(gsi, 264, 8, first.map(p2).join(''));    // TCF
    putAscii(gsi, 272, 1, '1');                       // TND
    putAscii(gsi, 273, 1, '1');                       // DSN
    putAscii(gsi, 274, 3, 'GBR');                     // CO

    const out = new Uint8Array(1024 + ttiBlocks.length * 128);
    out.set(gsi, 0);
    ttiBlocks.forEach((b, i) => out.set(b, 1024 + i * 128));
    return out;
  }

  function importSTL(data, opts = {}) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (u8.length < 1024) throw new Error('Not an EBU-STL file (too short).');
    const field = (off, len) => { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]); return s; };
    const dfc = field(3, 8);
    if (!/^STL\d\d\.01$/.test(dfc)) throw new Error('Not an EBU-STL file (bad GSI).');
    const base = parseInt(dfc.slice(3, 5), 10);
    // The file only says 25 or 30; the project clock decides what 30 really is.
    const ck = clock(opts);
    const nominal = base === 25 ? 25 : (ck.nominal === 25 ? 30 : ck.nominal);
    const fps = base === 25 ? 25 : (Math.abs(ck.fps - ck.nominal) < 1e-6 && ck.nominal !== 30 ? ck.fps : (ck.nominal === 30 ? ck.fps : 30000 / 1001));
    const drop = base !== 25 && ck.drop && nominal === 30 ? 2 : 0;
    let offset = opts.startOffsetSec;
    if (typeof offset !== 'number') {
      const tcp = field(256, 8);
      offset = /^\d{8}$/.test(tcp)
        ? tcToFrames(+tcp.slice(0, 2), +tcp.slice(2, 4), +tcp.slice(4, 6), +tcp.slice(6, 8), nominal, drop) / fps : 0;
    }
    const toSec = (o) => Math.max(0, tcToFrames(u8[o], u8[o + 1], u8[o + 2], u8[o + 3], nominal, drop) / fps - offset);

    const out = [];
    let cur = null;
    for (let o = 1024; o + 128 <= u8.length; o += 128) {
      const ebn = u8[o + 3];
      if (ebn === 0xFE) continue;                       // user data
      const bytes = Array.from(u8.subarray(o + 16, o + 128));
      if (!cur) cur = { start: toSec(o + 5), end: toSec(o + 9), bytes: [], comment: u8[o + 15] === 1 };
      cur.bytes.push(...bytes);
      if (ebn === 0xFF) {
        if (!cur.comment) {
          const text = stlDecodeText(cur.bytes).split('\n').map(l => l.trim()).filter(Boolean).join('\n');
          if (text) out.push({ start: cur.start, end: cur.end, text });
        }
        cur = null;
      }
    }
    return out;
  }

  return { exportTTML, importTTML, exportSCC, importSCC, exportSTL, importSTL,
    // exposed for tests
    _oddParity: oddParity, _framesToTc: framesToTc, _tcToFrames: tcToFrames };
})();

window.CaptionFormats = CaptionFormats;
