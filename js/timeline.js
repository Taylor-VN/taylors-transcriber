/**
 * Timeline Controller & Renderer
 * Interactive Multi-track Timeline with Drag, Trim Handles, Snapping, 25 FPS Ruler, and Waveform
 */

const TRACK_HEADER_WIDTH = 90;
const RULER_HEIGHT = 24;
const MIN_CLIP_SEC = 0.1;

// Canvas cannot read the CSS custom properties, so the tokens the tracks need
// are mirrored here. Keep these in step with :root in styles.css.
const TRACK_BG = '#171819';    // --bg-sunken
const TICK = '#3d4245';        // --border-strong
const TICK_LABEL = '#9ba1a6';  // --text-muted
const WAVE = '#22d3ee';        // --time, the timeline's own colour
const SILENCE = '#2c3033';     // --border, for a track with no audio in it

class TimelineController {
  constructor(rulerCanvas, waveformCanvas, subtitleTrackContainer, playheadElement, subtitleManager, videoPlayer, fps = 25) {
    this.rulerCanvas = rulerCanvas;
    this.waveformCanvas = waveformCanvas;
    this.subtitleContainer = subtitleTrackContainer;
    this.playhead = playheadElement;
    this.subManager = subtitleManager;
    this.player = videoPlayer;
    this.fps = fps;

    this.zoomLevel = 50; // Pixels per second
    this.duration = 60;  // Timeline total duration in seconds (default 60s)
    this.isDraggingPlayhead = false;
    this.draggedClipInfo = null;

    this.rulerCtx = this.rulerCanvas.getContext('2d');
    this.waveformCtx = this.waveformCanvas.getContext('2d');

    this.initEvents();
  }

  initEvents() {
    this.subManager.onChange(() => {
      // Grow the timeline if captions now run past the end of it.
      const wanted = this.computeDuration(this.player.getDuration());
      if (Math.abs(wanted - this.duration) > 0.5) {
        this.duration = wanted;
        this.resizeAndDraw();
      } else {
        this.renderClips();
      }
    });

    this.player.onTimeUpdate((currentTime, duration) => {
      const wanted = this.computeDuration(duration);
      if (Math.abs(wanted - this.duration) > 0.5) {
        this.duration = wanted;
        this.resizeAndDraw();
      }
      this.updatePlayheadPosition(currentTime);
    });

    // Ruler & Playhead click / scrub
    this.rulerCanvas.addEventListener('mousedown', (e) => {
      this.isDraggingPlayhead = true;
      this.scrubPlayheadFromEvent(e);
    });

    if (this.playhead) {
      this.playhead.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.isDraggingPlayhead = true;
        document.body.style.cursor = 'ew-resize';
      });
    }

    const tracksWrapper = document.getElementById('tracksWrapper');
    if (tracksWrapper) {
      tracksWrapper.addEventListener('mousedown', (e) => {
        if (!e.target.classList.contains('subtitle-clip') && !e.target.classList.contains('clip-handle') && !e.target.classList.contains('clip-text')) {
          this.isDraggingPlayhead = true;
          this.scrubPlayheadFromEvent(e);
        }
      });
    }

    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingPlayhead) {
        this.scrubPlayheadFromEvent(e);
      } else if (this.draggedClipInfo) {
        this.handleClipDragMove(e);
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDraggingPlayhead = false;
      if (this.draggedClipInfo) {
        this.draggedClipInfo = null;
        this.renderClips();
      }
      document.body.style.cursor = 'default';
    });

    window.addEventListener('resize', () => this.scheduleResize());

    // A panel can change width without a window resize, and CSS scaling of a
    // fixed-size canvas is exactly what distorted the ruler, so watch the
    // element itself.
    const container = document.getElementById('timelineContainer');
    if (container && window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
      this.resizeObserver.observe(container);
    }
    setTimeout(() => this.resizeAndDraw(), 100);
  }

  /** Coalesces resize bursts into one redraw on the next frame. */
  scheduleResize() {
    if (this.resizePending) return;
    this.resizePending = true;
    requestAnimationFrame(() => {
      this.resizePending = false;
      this.resizeAndDraw();
    });
  }

  setZoom(pxPerSec) {
    this.zoomLevel = Math.max(10, Math.min(300, pxPerSec));
    this.resizeAndDraw();
    return this.zoomLevel;
  }

  /** Timeline must always be long enough to hold the media AND every caption. */
  computeDuration(mediaDuration) {
    const subs = this.subManager.getSubtitles();
    const lastCaptionEnd = subs.length ? Math.max(...subs.map(s => s.end)) : 0;
    const media = (mediaDuration && isFinite(mediaDuration) && mediaDuration > 0)
      ? mediaDuration
      : this.player.getDuration();
    return Math.max(30, media, lastCaptionEnd + 5);
  }

  /**
   * Measures the space available to the timeline.
   *
   * The content is at least as wide as the visible area, so a short project at
   * low zoom fills the panel instead of leaving the canvases to be stretched by
   * CSS — which was distorting the ruler timecodes and pulling them out of
   * alignment with the (absolutely positioned, unstretched) clips.
   */
  measure() {
    const container = document.getElementById('timelineContainer');
    const headerEl = this.rulerCanvas.closest('.timeline-ruler-wrapper')
      ? this.rulerCanvas.closest('.timeline-ruler-wrapper').querySelector('.track-header')
      : null;

    const headerWidth = headerEl ? headerEl.getBoundingClientRect().width : TRACK_HEADER_WIDTH;
    const visible = container ? container.clientWidth : 0;
    const available = Math.max(200, visible - headerWidth);
    const needed = this.duration * this.zoomLevel;

    const waveTrack = this.waveformCanvas.parentElement;
    const waveHeight = waveTrack ? Math.max(24, Math.round(waveTrack.getBoundingClientRect().height)) : 50;
    const rulerHeight = Math.max(18, Math.round(
      (this.rulerCanvas.parentElement || {}).clientHeight || RULER_HEIGHT));

    return {
      headerWidth,
      contentWidth: Math.max(available, needed),
      rulerHeight,
      waveHeight,
    };
  }

  /**
   * Sizes a canvas so one backing pixel maps to one device pixel.
   * Without this the ruler is both blurry on a Retina display and, worse,
   * scaled by whatever ratio CSS chose — which is what stretched the timecodes.
   */
  sizeCanvas(canvas, cssWidth, cssHeight) {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const backingW = Math.round(cssWidth * dpr);
    const backingH = Math.round(cssHeight * dpr);

    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  resizeAndDraw() {
    this.duration = this.computeDuration(this.player.getDuration());
    const m = this.measure();
    this.contentWidth = m.contentWidth;
    this.headerWidth = m.headerWidth;

    this.sizeCanvas(this.rulerCanvas, m.contentWidth, m.rulerHeight);
    this.sizeCanvas(this.waveformCanvas, m.contentWidth, m.waveHeight);

    // Clips are positioned in CSS pixels against this element, so it must be
    // exactly as wide as the canvases for the two to stay in register.
    this.subtitleContainer.style.width = `${m.contentWidth}px`;

    this.drawRuler();
    this.drawWaveform();
    this.renderClips();
    this.updatePlayheadPosition(this.player.getCurrentTime());
  }

  // --- Draw 25 FPS Timeline Ruler ---
  drawRuler() {
    const ctx = this.rulerCtx;
    // CSS pixels: the context carries a devicePixelRatio transform.
    const w = this.contentWidth || this.rulerCanvas.clientWidth;
    const h = parseFloat(this.rulerCanvas.style.height) || RULER_HEIGHT;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = TRACK_BG;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = TICK;
    ctx.fillStyle = TICK_LABEL;
    ctx.font = '10px "Roboto Mono", monospace';

    // Pick the tick spacing that keeps labels from colliding at this zoom.
    const labelWidth = ctx.measureText('00:00:00:00').width + 14;
    const candidates = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const majorStep = candidates.find(step => step * this.zoomLevel >= labelWidth)
      || candidates[candidates.length - 1];
    // Minor ticks subdivide the major step without ever going below one frame.
    const minorStep = Math.max(1 / this.fps, majorStep / 5);

    for (let sec = 0; sec <= this.duration + majorStep; sec += majorStep) {
      const x = sec * this.zoomLevel;

      ctx.beginPath();
      ctx.moveTo(x, h - 10);
      ctx.lineTo(x, h);
      ctx.stroke();

      ctx.fillText(this.subManager.secondsToTimecode(sec, this.fps), x + 4, 12);

      // Minor ticks between this label and the next
      for (let t = sec + minorStep; t < sec + majorStep - 1e-9; t += minorStep) {
        const mx = t * this.zoomLevel;
        ctx.beginPath();
        ctx.moveTo(mx, h - 4);
        ctx.lineTo(mx, h);
        ctx.stroke();
      }

      // Individual frame ticks only once a frame is comfortably wide
      if (this.zoomLevel / this.fps >= 4) {
        for (let f = 1; f < majorStep * this.fps; f++) {
          const fx = (sec + f / this.fps) * this.zoomLevel;
          ctx.beginPath();
          ctx.moveTo(fx, h - 2);
          ctx.lineTo(fx, h);
          ctx.stroke();
        }
      }
    }
  }

  /**
   * Draws the decoded audio for the loaded media. With nothing loaded there is
   * no audio to draw, so the track holds a flat baseline: a stand-in pattern
   * would be read as a real signal and timed against.
   */
  drawWaveform() {
    const ctx = this.waveformCtx;
    const w = this.contentWidth || this.waveformCanvas.clientWidth;
    const h = parseFloat(this.waveformCanvas.style.height) || 50;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = TRACK_BG;
    ctx.fillRect(0, 0, w, h);

    ctx.lineWidth = 1;

    if (!this.peaks) {
      ctx.strokeStyle = SILENCE;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(h / 2) + 0.5);
      ctx.lineTo(w, Math.round(h / 2) + 0.5);
      ctx.stroke();
      return;
    }

    ctx.strokeStyle = WAVE;

    const barWidth = 3;
    const gap = 1;
    const step = barWidth + gap;
    const totalBars = Math.floor(w / step);

    ctx.beginPath();
    for (let i = 0; i < totalBars; i++) {
      const x = i * step;
      const amp = this.peakAt(x / this.zoomLevel) * (h * 0.46);
      ctx.moveTo(x, (h / 2) - amp);
      ctx.lineTo(x, (h / 2) + amp);
    }
    ctx.stroke();
  }

  /** Peak amplitude (0..1) at a given time, from the decoded peaks array. */
  peakAt(timeSec) {
    if (!this.peaks || !this.peaksDuration) return 0;
    const idx = Math.floor((timeSec / this.peaksDuration) * this.peaks.length);
    if (idx < 0 || idx >= this.peaks.length) return 0;
    return this.peaks[idx];
  }

  /**
   * Swap in a waveform that was decoded earlier. Films keep their own peaks for
   * the session, so switching tabs redraws the right waveform instantly instead
   * of decoding the audio again.
   */
  setWaveform(peaks, durationSec) {
    this.peaks = peaks || null;
    this.peaksDuration = durationSec || 0;
    this.drawWaveform();
  }

  getWaveform() {
    return { peaks: this.peaks || null, duration: this.peaksDuration || 0 };
  }

  /** Decode the loaded media's audio and build a real peaks array. */
  async loadAudioWaveform(file) {
    this.peaks = null;
    this.peaksDuration = 0;
    this.drawWaveform();
    if (!file) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new AudioCtx();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      const channel = audioBuffer.getChannelData(0);
      const bucketCount = 4000;
      const samplesPerBucket = Math.max(1, Math.floor(channel.length / bucketCount));
      const peaks = new Float32Array(bucketCount);

      for (let b = 0; b < bucketCount; b++) {
        const startIdx = b * samplesPerBucket;
        let peak = 0;
        for (let s = 0; s < samplesPerBucket; s++) {
          const v = Math.abs(channel[startIdx + s] || 0);
          if (v > peak) peak = v;
        }
        peaks[b] = peak;
      }

      this.peaks = peaks;
      this.peaksDuration = audioBuffer.duration;
      audioCtx.close();
      this.drawWaveform();
    } catch (e) {
      console.warn('Could not decode audio for the waveform:', e);
      this.peaks = null;
      this.drawWaveform();
    }
  }

  // --- Update Playhead Position ---
  updatePlayheadPosition(currentTimeSec) {
    const offset = this.headerWidth || TRACK_HEADER_WIDTH;
    this.playhead.style.left = `${offset + (currentTimeSec * this.zoomLevel)}px`;
  }

  scrubPlayheadFromEvent(e) {
    const container = document.getElementById('timelineContainer');
    const rect = this.rulerCanvas.getBoundingClientRect();
    let clickX = e.clientX - rect.left;
    if (isNaN(clickX) || clickX < 0) clickX = 0;

    const targetSec = Math.max(0, clickX / this.zoomLevel);
    this.player.seek(targetSec);
  }

  // --- Subtitle Track Clips Rendering & Dragging ---
  /**
   * Ids of captions whose span intersects another. Overlaps should not be
   * reachable by dragging any more, but imports and hand-edited timecodes can
   * still produce them, and only one caption can be on screen at a time — so
   * they are flagged rather than left to silently shadow each other.
   */
  findOverlaps(subs) {
    const overlapping = new Set();
    for (let i = 0; i < subs.length; i++) {
      for (let j = i + 1; j < subs.length; j++) {
        if (subs[j].start >= subs[i].end) break; // sorted by start
        overlapping.add(subs[i].id);
        overlapping.add(subs[j].id);
      }
    }
    return overlapping;
  }

  renderClips() {
    this.subtitleContainer.innerHTML = '';
    const subs = this.subManager.getSubtitles();
    const selectedId = this.subManager.selectedId;
    const draggingId = this.draggedClipInfo ? this.draggedClipInfo.id : null;
    const overlapping = this.findOverlaps(subs);

    subs.forEach(sub => {
      const clipEl = document.createElement('div');
      // Stacking decides which clip's trim handles are grabbable where two
      // overlap, so the one being worked on is always raised above its
      // neighbours.
      clipEl.className = [
        'subtitle-clip',
        sub.id === selectedId ? 'selected' : '',
        sub.id === draggingId ? 'dragging' : '',
        overlapping.has(sub.id) ? 'overlapping' : ''
      ].filter(Boolean).join(' ');

      if (overlapping.has(sub.id)) {
        clipEl.title = 'This caption overlaps another. Only one caption shows at a '
          + 'time, so drag or trim them apart.';
      }

      const leftPx = sub.start * this.zoomLevel;
      const widthPx = Math.max(16, (sub.end - sub.start) * this.zoomLevel);

      clipEl.style.left = `${leftPx}px`;
      clipEl.style.width = `${widthPx}px`;
      clipEl.dataset.id = sub.id;

      // Left Trim Handle
      const leftHandle = document.createElement('div');
      leftHandle.className = 'clip-handle handle-left';
      leftHandle.title = 'Trim the in point';
      leftHandle.addEventListener('mousedown', (e) => this.startClipDrag(e, sub.id, 'trim-left'));

      // Right Trim Handle
      const rightHandle = document.createElement('div');
      rightHandle.className = 'clip-handle handle-right';
      rightHandle.title = 'Trim the out point';
      rightHandle.addEventListener('mousedown', (e) => this.startClipDrag(e, sub.id, 'trim-right'));

      // Text Label
      const textEl = document.createElement('span');
      textEl.className = 'clip-text';
      textEl.textContent = sub.text || '(empty)';

      clipEl.appendChild(leftHandle);
      clipEl.appendChild(textEl);
      clipEl.appendChild(rightHandle);

      // Clip Body Drag
      clipEl.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('clip-handle')) return;
        this.subManager.selectSubtitle(sub.id);
        this.startClipDrag(e, sub.id, 'move');
      });

      clipEl.addEventListener('dblclick', () => {
        const itemEl = document.querySelector(`.caption-item[data-id="${sub.id}"] .caption-textarea`);
        if (itemEl) {
          itemEl.focus();
          itemEl.select();
        }
      });

      this.subtitleContainer.appendChild(clipEl);
    });
  }

  /**
   * How far a clip may travel before it would collide with a neighbour.
   *
   * Measured once at drag start, so the limits cannot shift under the cursor as
   * the store re-sorts mid-drag.
   *
   * Only clips that are *clear* of this one count as neighbours. If the caption
   * already overlaps something — imported SRTs and hand-typed timecodes can do
   * that — no limit is found on that side, which leaves the user free to drag
   * out of the overlap rather than being pinned inside it.
   */
  neighbourLimits(sub) {
    let left = 0;
    let right = Infinity;

    this.subManager.getSubtitles().forEach(other => {
      if (other.id === sub.id) return;
      if (other.end <= sub.start) left = Math.max(left, other.end);
      if (other.start >= sub.end) right = Math.min(right, other.start);
    });

    return { left, right };
  }

  startClipDrag(e, subId, mode) {
    e.stopPropagation();
    e.preventDefault();
    const sub = this.subManager.getSubtitles().find(s => s.id === subId);
    if (!sub) return;

    this.draggedClipInfo = {
      id: subId,
      mode: mode, // 'move', 'trim-left', 'trim-right'
      startX: e.clientX,
      initialStart: sub.start,
      initialEnd: sub.end,
      initialDuration: sub.end - sub.start,
      limits: this.neighbourLimits(sub)
    };

    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
    this.renderClips();
  }

  /**
   * Candidate snap points: the playhead plus every *other* clip's in/out point.
   * The threshold is in pixels so snapping feels the same at any zoom level.
   */
  snapTime(timeSec, excludeId) {
    const snapEnabled = document.getElementById('snapToGrid')?.checked !== false;
    if (!snapEnabled) return timeSec;

    const thresholdSec = 8 / this.zoomLevel; // 8 screen pixels
    const candidates = [this.player.getCurrentTime(), 0];
    this.subManager.getSubtitles().forEach(s => {
      if (s.id === excludeId) return;
      candidates.push(s.start, s.end);
    });

    let best = timeSec;
    let bestDist = thresholdSec;
    candidates.forEach(c => {
      const dist = Math.abs(timeSec - c);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    });
    return best;
  }

  handleClipDragMove(e) {
    if (!this.draggedClipInfo) return;
    const { id, mode, startX, initialStart, initialEnd, initialDuration, limits } =
      this.draggedClipInfo;
    const deltaSec = (e.clientX - startX) / this.zoomLevel;

    // Captions are sequential: only one can be on screen at a time, so an
    // overlap silently hides one of them. Keep a frame of clear air between
    // neighbours, the way Premiere's caption track does.
    const gap = 1 / this.fps;
    const minLen = MIN_CLIP_SEC;
    const lowBound = limits.left > 0 ? limits.left + gap : 0;
    const highBound = limits.right < Infinity ? limits.right - gap : Infinity;

    let newStart = initialStart;
    let newEnd = initialEnd;

    if (mode === 'move') {
      newStart = this.snapTime(initialStart + deltaSec, id);
      // Snapping runs first so it can still latch onto a neighbour's edge, then
      // the clamp guarantees the result cannot cross it.
      const latestStart = highBound === Infinity ? Infinity : highBound - initialDuration;
      newStart = Math.min(Math.max(newStart, lowBound), Math.max(lowBound, latestStart));
      newStart = Math.max(0, newStart);
      newEnd = newStart + initialDuration;
    } else if (mode === 'trim-left') {
      newStart = this.snapTime(initialStart + deltaSec, id);
      newStart = Math.max(lowBound, Math.min(newStart, initialEnd - minLen));
      newStart = Math.max(0, newStart);
      newEnd = initialEnd;
    } else if (mode === 'trim-right') {
      newEnd = this.snapTime(initialEnd + deltaSec, id);
      newEnd = Math.min(highBound, Math.max(newEnd, initialStart + minLen));
      newStart = initialStart;
    }

    this.subManager.updateSubtitle(id, { start: newStart, end: newEnd });
  }
}

window.TimelineController = TimelineController;
