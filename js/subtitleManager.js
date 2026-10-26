/**
 * Subtitle Manager
 * Handles subtitles data store, frame-rate / drop-frame timecode utilities, SRT/VTT parsing and export
 */

/**
 * Every frame rate a project can run at. `num`/`den` is the true rate (what
 * ffmpeg wants, e.g. 24000/1001); `timebase` is the whole-number rate that
 * timecode counts in and that Premiere's <timebase> carries, with `ntsc` marking
 * the 1000/1001 pull-down. Caption times are stored in seconds, so changing the
 * rate never rewrites them.
 */
const FRAME_RATES = [
  { id: '23.976', label: '23.976',     num: 24000, den: 1001, timebase: 24, ntsc: true,  drop: false },
  { id: '24',     label: '24',         num: 24,    den: 1,    timebase: 24, ntsc: false, drop: false },
  { id: '25',     label: '25',         num: 25,    den: 1,    timebase: 25, ntsc: false, drop: false },
  { id: '29.97',  label: '29.97 NDF',  num: 30000, den: 1001, timebase: 30, ntsc: true,  drop: false },
  { id: '29.97df', label: '29.97 DF',  num: 30000, den: 1001, timebase: 30, ntsc: true,  drop: true },
  { id: '30',     label: '30',         num: 30,    den: 1,    timebase: 30, ntsc: false, drop: false },
  { id: '50',     label: '50',         num: 50,    den: 1,    timebase: 50, ntsc: false, drop: false },
  { id: '59.94',  label: '59.94 NDF',  num: 60000, den: 1001, timebase: 60, ntsc: true,  drop: false },
  { id: '59.94df', label: '59.94 DF',  num: 60000, den: 1001, timebase: 60, ntsc: true,  drop: true },
  { id: '60',     label: '60',         num: 60,    den: 1,    timebase: 60, ntsc: false, drop: false }
];
const DEFAULT_FRAME_RATE_ID = '25';

function getFrameRate(id) {
  return FRAME_RATES.find(r => r.id === String(id)) || FRAME_RATES.find(r => r.id === DEFAULT_FRAME_RATE_ID);
}

/** Closest supported non-drop rate to a measured fps, or null if nothing is near. */
function nearestFrameRate(fps) {
  let best = null;
  FRAME_RATES.forEach(r => {
    if (r.drop) return;
    const d = Math.abs(r.num / r.den - fps);
    if (d < 0.05 && (!best || d < best.d)) best = { rate: r, d };
  });
  return best ? best.rate : null;
}

class SubtitleManager {
  /** @param {number|string} rateId  an id from FRAME_RATES (a bare number such as 25 works too) */
  constructor(rateId = DEFAULT_FRAME_RATE_ID) {
    this.subtitles = [];
    this.startTimecode = '00:00:00:00';
    this.startFrames = 0;
    this.setFrameRate(rateId);
    this.selectedId = null;
    this.listeners = [];
  }

  onChange(callback) {
    this.listeners.push(callback);
  }

  notify() {
    this.listeners.forEach(cb => cb(this.subtitles, this.selectedId));
  }

  // --- Frame rate & start timecode ---
  /**
   * Switches the project rate. Other modules read `fps` (the true rate, e.g.
   * 30000/1001), `timebase` (what timecode counts in), `dropFrame` and
   * `startOffsetSec` straight off this object, so they stay live.
   */
  setFrameRate(rateId) {
    const rate = typeof rateId === 'object' && rateId ? rateId : getFrameRate(rateId);
    this.rate = rate;
    this.rateId = rate.id;
    this.fps = rate.num / rate.den;
    this.timebase = rate.timebase;
    this.dropFrame = rate.drop;
    this.setStartTimecode(this.startTimecode);
  }

  /**
   * The timecode the first frame of the sequence carries (01:00:00:00 and
   * 10:00:00:00 are the usual ones). Held as text and re-read on a rate change
   * so a drop-frame start still lands on a valid label.
   */
  setStartTimecode(tc) {
    const frames = this.timecodeToFrames(tc);
    this.startFrames = frames === null ? 0 : frames;
    this.startTimecode = this.framesToTimecode(this.startFrames);
    this.startOffsetSec = this.startFrames / this.fps;
  }

  /** Whole-frame index of a time, nudged so 1.2s at 25fps is frame 30, not 29. */
  secondsToFrames(seconds) {
    return Math.floor(seconds * this.fps + 1e-6);
  }

  /** Frame count -> "HH:MM:SS:FF" ("HH:MM:SS;FF" when drop-frame). */
  framesToTimecode(frameCount) {
    const tb = this.timebase;
    let n = Math.max(0, Math.floor(frameCount));
    if (this.dropFrame) {
      // Drop-frame skips labels, not frames: 2 (or 4 at 59.94) at the start of
      // every minute that is not a tenth minute, which keeps the label within
      // a frame or so of the wall clock.
      const drop = tb === 60 ? 4 : 2;
      const perMin = tb * 60 - drop;
      const per10 = tb * 600 - drop * 9;
      const tens = Math.floor(n / per10);
      const rem = n % per10;
      n += drop * 9 * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMin) : 0);
    }
    const frames = n % tb;
    const totalSeconds = Math.floor(n / tb);
    const secs = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const mins = totalMinutes % 60;
    const hrs = Math.floor(totalMinutes / 60);

    const pad = (v) => v.toString().padStart(2, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}${this.dropFrame ? ';' : ':'}${pad(frames)}`;
  }

  /** "HH:MM:SS:FF" (or ';' before FF) -> frame count, or null if it is not that shape. */
  timecodeToFrames(tc) {
    const m = String(tc || '').trim().match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
    if (!m) return null;
    const [h, mi, s, f] = m.slice(1).map(Number);
    const tb = this.timebase;
    let n = (h * 3600 + mi * 60 + s) * tb + f;
    if (this.dropFrame) {
      const drop = tb === 60 ? 4 : 2;
      const totalMinutes = h * 60 + mi;
      n -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
    }
    return Math.max(0, n);
  }

  // --- Timecode Helpers ---
  /**
   * Seconds -> display timecode. The start timecode is added unless
   * `useOffset` is false (SRT/VTT-style zero-based output wants that).
   */
  secondsToTimecode(seconds, fps = this.fps, useOffset = true) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    // A caller-supplied rate other than ours is rare (nothing in-tree does it);
    // honour it by temporarily doing the plain non-drop count.
    let frameCount;
    if (Math.abs(fps - this.fps) < 1e-9) {
      frameCount = this.secondsToFrames(seconds) + (useOffset ? this.startFrames : 0);
      return this.framesToTimecode(frameCount);
    }
    const saved = { fps: this.fps, timebase: this.timebase, dropFrame: this.dropFrame };
    this.fps = fps;
    this.timebase = Math.round(fps);
    this.dropFrame = false;
    try {
      return this.framesToTimecode(this.secondsToFrames(seconds));
    } finally {
      Object.assign(this, saved);
    }
  }

  /**
   * Parses HH:MM:SS:FF (frames, drop-frame aware), HH:MM:SS.mmm or MM:SS.mmm.
   * `useOffset` subtracts the start timecode, for text the user typed against
   * the displayed timecode; file parsers (SRT/VTT) leave it off.
   */
  timecodeToSeconds(tc, fps = this.fps, useOffset = false) {
    if (!tc) return 0;
    const cleanTc = String(tc).trim().replace(',', '.');
    const offset = useOffset ? this.startOffsetSec : 0;
    const parts = cleanTc.replace(';', ':').split(':');

    if (parts.length === 4) {
      if (Math.abs(fps - this.fps) < 1e-9) {
        const frames = this.timecodeToFrames(cleanTc);
        if (frames !== null) return Math.max(0, (frames - (useOffset ? this.startFrames : 0)) / this.fps);
      }
      const hrs = parseFloat(parts[0]) || 0;
      const mins = parseFloat(parts[1]) || 0;
      const secs = parseFloat(parts[2]) || 0;
      const frames = parseFloat(parts[3]) || 0;
      return Math.max(0, hrs * 3600 + mins * 60 + secs + (frames / fps) - offset);
    } else if (parts.length === 3) {
      const hrs = parseFloat(parts[0]) || 0;
      const mins = parseFloat(parts[1]) || 0;
      const secs = parseFloat(parts[2]) || 0;
      return Math.max(0, hrs * 3600 + mins * 60 + secs - offset);
    } else if (parts.length === 2) {
      const mins = parseFloat(parts[0]) || 0;
      const secs = parseFloat(parts[1]) || 0;
      return Math.max(0, mins * 60 + secs - offset);
    }
    return Math.max(0, (parseFloat(cleanTc) || 0) - offset);
  }

  // --- Subtitle CRUD ---
  getSubtitles() {
    return this.subtitles;
  }

  setSubtitles(newSubs) {
    this.subtitles = newSubs.map((sub, i) => ({
      id: sub.id || 'sub_' + Date.now() + '_' + i,
      start: typeof sub.start === 'number' ? sub.start : this.timecodeToSeconds(sub.start),
      end: typeof sub.end === 'number' ? sub.end : this.timecodeToSeconds(sub.end),
      text: sub.text || '',
      speaker: sub.speaker || '',
      // Carried through from transcription so the review UI can point at the
      // words the model was unsure about. Absent for hand-authored captions.
      words: Array.isArray(sub.words) ? sub.words : undefined,
      uncertain: Array.isArray(sub.uncertain) ? sub.uncertain : undefined
    })).sort((a, b) => a.start - b.start);
    this.notify();
  }

  /** Captions carrying at least one word the model was unsure about. */
  uncertainSubtitles() {
    return this.subtitles.filter(s => s.uncertain && s.uncertain.length);
  }

  addSubtitle(startSec, endSec, text = 'New Caption Line', speaker = '') {
    const newSub = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      start: startSec,
      end: endSec > startSec ? endSec : startSec + 2.0,
      text: text,
      speaker: speaker
    };
    this.subtitles.push(newSub);
    this.subtitles.sort((a, b) => a.start - b.start);
    this.selectedId = newSub.id;
    this.notify();
    return newSub;
  }

  /**
   * @param {Object} opts  { silent: true } updates the model without firing a
   *   re-render — used while typing in the caption box so the textarea is not
   *   torn down and rebuilt on every keystroke.
   */
  updateSubtitle(id, updates, opts = {}) {
    const sub = this.subtitles.find(s => s.id === id);
    if (!sub) return false;

    if (updates.start !== undefined && !isNaN(updates.start)) sub.start = Math.max(0, updates.start);
    if (updates.end !== undefined && !isNaN(updates.end)) sub.end = Math.max(sub.start + 0.1, updates.end);
    if (updates.text !== undefined) sub.text = updates.text;
    if (updates.speaker !== undefined) sub.speaker = updates.speaker;

    this.subtitles.sort((a, b) => a.start - b.start);
    if (!opts.silent) this.notify();
    return true;
  }

  deleteSubtitle(id) {
    this.subtitles = this.subtitles.filter(s => s.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.notify();
  }

  selectSubtitle(id) {
    // Re-selecting the same line must not fire a change: listeners re-render the
    // list, and a re-render that restores focus would call back in here forever.
    if (this.selectedId === id) return false;
    this.selectedId = id;
    this.notify();
    return true;
  }

  /**
   * The caption on screen at `timeSec`.
   *
   * Where two captions overlap the later-starting one wins. Returning the first
   * match instead meant an overlapping caption was silently never displayed —
   * and never exported — which is a confusing way to lose a line.
   */
  getActiveSubtitleAt(timeSec) {
    let active = null;
    for (const sub of this.subtitles) {
      if (timeSec >= sub.start && timeSec <= sub.end) {
        if (!active || sub.start >= active.start) active = sub;
      }
    }
    return active;
  }

  /** Pairs of captions whose spans intersect. Empty when the track is clean. */
  findOverlaps() {
    const out = [];
    for (let i = 0; i < this.subtitles.length; i++) {
      for (let j = i + 1; j < this.subtitles.length; j++) {
        if (this.subtitles[j].start >= this.subtitles[i].end) break;
        out.push([this.subtitles[i].id, this.subtitles[j].id]);
      }
    }
    return out;
  }

  splitSubtitleAt(id, timeSec) {
    const sub = this.subtitles.find(s => s.id === id);
    if (!sub || timeSec <= sub.start || timeSec >= sub.end) return false;

    const originalEnd = sub.end;
    const words = sub.text.trim().split(/\s+/);
    const midIndex = Math.max(1, Math.floor(words.length / 2));
    const text1 = words.slice(0, midIndex).join(' ') || sub.text;
    const text2 = words.slice(midIndex).join(' ') || '...';

    sub.end = timeSec;
    sub.text = text1;

    this.addSubtitle(timeSec + (1 / this.fps), originalEnd, text2, sub.speaker);
    return true;
  }

  mergeSubtitle(id) {
    const idx = this.subtitles.findIndex(s => s.id === id);
    if (idx === -1 || idx >= this.subtitles.length - 1) return false;

    const currentSub = this.subtitles[idx];
    const nextSub = this.subtitles[idx + 1];

    currentSub.end = nextSub.end;
    currentSub.text = (currentSub.text.trim() + ' ' + nextSub.text.trim()).trim();

    this.subtitles.splice(idx + 1, 1);
    this.notify();
    return true;
  }

  rippleDeleteSubtitle(id) {
    const idx = this.subtitles.findIndex(s => s.id === id);
    if (idx === -1) return;

    const sub = this.subtitles[idx];
    const duration = sub.end - sub.start;

    // Shift all subsequent subtitles back by duration
    for (let i = idx + 1; i < this.subtitles.length; i++) {
      this.subtitles[i].start = Math.max(0, this.subtitles[i].start - duration);
      this.subtitles[i].end = Math.max(0.1, this.subtitles[i].end - duration);
    }

    this.subtitles.splice(idx, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.notify();
  }

  shiftAllTimecodes(offsetSec) {
    if (isNaN(offsetSec) || offsetSec === 0) return;
    this.subtitles.forEach(sub => {
      sub.start = Math.max(0, sub.start + offsetSec);
      sub.end = Math.max(sub.start + 0.1, sub.end + offsetSec);
    });
    this.notify();
  }

  clearAll() {
    this.subtitles = [];
    this.selectedId = null;
    this.notify();
  }

  // --- Premiere Pro Sequence XML (FCP7 xmeml) Export ---
  /**
   * Emits a well-formed xmeml v4 sequence. Note this uses <clipitem>, the
   * element Premiere actually reads — <trackitem> is not part of the schema and
   * imports as an empty sequence.
   */
  exportPremiereXml(project = { width: 1920, height: 1080 }) {
    // Frame counts below are in true-rate frames; the <rate> element carries
    // the whole-number timebase plus the NTSC flag for 1000/1001 rates.
    const fps = this.fps;
    const esc = (s) => String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const lastEnd = this.subtitles.length
      ? Math.max(...this.subtitles.map(s => s.end))
      : 0;
    const sequenceDuration = Math.max(1, Math.ceil(lastEnd * fps));

    const rate = `<rate><timebase>${this.timebase}</timebase><ntsc>${this.rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
    // Where the sequence's first frame sits on the timecode clock.
    const seqTimecode = `<timecode>
      ${rate}
      <string>${this.startTimecode}</string>
      <frame>${this.startFrames}</frame>
      <displayformat>${this.dropFrame ? 'DF' : 'NDF'}</displayformat>
    </timecode>`;

    const clipNodes = this.subtitles.map((sub, i) => {
      const inFrame = Math.round(sub.start * fps);
      const outFrame = Math.max(inFrame + 1, Math.round(sub.end * fps));
      const label = esc((sub.text || '').replace(/\s+/g, ' ').trim().slice(0, 80) || `Caption ${i + 1}`);
      return `          <clipitem id="clipitem-${i + 1}">
            <name>${label}</name>
            <enabled>TRUE</enabled>
            <duration>${outFrame - inFrame}</duration>
            ${rate}
            <start>${inFrame}</start>
            <end>${outFrame}</end>
            <in>0</in>
            <out>${outFrame - inFrame}</out>
            <comments><mastercomment1>${label}</mastercomment1></comments>
          </clipitem>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="subtitler-sequence">
    <name>Subtitled Sequence (${this.rate.label} FPS)</name>
    <duration>${sequenceDuration}</duration>
    ${rate}
    ${seqTimecode}
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rate}
            <width>${project.width}</width>
            <height>${project.height}</height>
            <pixelaspectratio>square</pixelaspectratio>
          </samplecharacteristics>
        </format>
        <track>
${clipNodes}
        </track>
      </video>
    </media>
  </sequence>
</xmeml>`;
  }

  // --- SRT & WebVTT Import/Export ---
  /**
   * Parses and commits in one step. Kept for callers that want exactly that;
   * anything routing the captions somewhere else — such as into every aspect
   * ratio of a film at once — should use parseSubtitleText and place them.
   */
  parseSRT(srtText) {
    this.setSubtitles(this.parseSubtitleText(srtText));
  }

  /** Parses SRT or WebVTT and returns the cues without touching the store. */
  parseSubtitleText(srtText) {
    // Strip a UTF-8 BOM and any WEBVTT header/NOTE blocks so the same parser
    // handles .srt and .vtt.
    const cleaned = String(srtText || '')
      .replace(/^﻿/, '')
      .replace(/^WEBVTT[^\n]*\n(?:[^\n]*\n)*?(?=\n)/i, '')
      .replace(/^NOTE[^\n]*(?:\n[^\n]+)*\n?/gim, '');

    // NOTE: the lookahead must end on a real end-of-input (`$`), not a literal
    // "$", otherwise the final cue in a file with no trailing blank line is
    // silently dropped.
    const pattern = /(\d+)?\s*\r?\n?(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})[^\n]*\r?\n([\s\S]*?)(?=\r?\n\s*\r?\n|\s*$)/g;
    const subs = [];
    let match;
    let idx = 0;

    while ((match = pattern.exec(cleaned)) !== null) {
      const text = match[4].replace(/<[^>]*>/g, '').trim();
      if (!match[2] || !match[3]) continue;
      subs.push({
        id: 'sub_srt_' + (idx++),
        start: this.timecodeToSeconds(match[2]),
        end: this.timecodeToSeconds(match[3]),
        text: text
      });
    }

    if (subs.length === 0) {
      // Fallback simpler regex parser
      const blocks = cleaned.trim().split(/\r?\n\r?\n/);
      blocks.forEach((block, idx) => {
        const lines = block.split(/\r?\n/);
        if (lines.length >= 2) {
          const tcLine = lines.find(l => l.includes('-->'));
          if (tcLine) {
            const [startStr, endStr] = tcLine.split('-->');
            const textLines = lines.slice(lines.indexOf(tcLine) + 1).join('\n');
            subs.push({
              id: 'sub_srt_' + idx,
              start: this.timecodeToSeconds(startStr),
              end: this.timecodeToSeconds(endStr),
              text: textLines.trim()
            });
          }
        }
      });
    }

    return subs;
  }

  /**
   * @param opts.speakers  carry speaker names into the cue text
   *
   * SubRip has no field for a speaker, so the name goes in front of the text —
   * the convention every caption house uses, and the one Premiere reads back as
   * plain text rather than dropping.
   */
  exportSRT(opts = {}) {
    return this.subtitles.map((sub, i) => {
      const startSrt = this.secondsToSrtTimecode(sub.start);
      const endSrt = this.secondsToSrtTimecode(sub.end);
      const text = opts.speakers && sub.speaker ? `${sub.speaker}: ${sub.text}` : sub.text;
      return `${i + 1}\n${startSrt} --> ${endSrt}\n${text}\n`;
    }).join('\n');
  }

  /**
   * WebVTT does have a speaker field — the voice span — so it is used rather
   * than a prefix. Players that ignore it still show the text.
   */
  exportVTT(opts = {}) {
    const body = this.subtitles.map((sub, i) => {
      const startVtt = this.secondsToSrtTimecode(sub.start).replace(',', '.');
      const endVtt = this.secondsToSrtTimecode(sub.end).replace(',', '.');
      const text = opts.speakers && sub.speaker
        ? `<v ${sub.speaker.replace(/[<>]/g, '')}>${sub.text}</v>`
        : sub.text;
      return `${i + 1}\n${startVtt} --> ${endVtt}\n${text}\n`;
    }).join('\n');
    return `WEBVTT\n\n${body}`;
  }

  secondsToSrtTimecode(sec) {
    if (isNaN(sec) || sec < 0) sec = 0;
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    const pad = (n, len = 2) => n.toString().padStart(len, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
  }
}

window.SubtitleManager = SubtitleManager;
