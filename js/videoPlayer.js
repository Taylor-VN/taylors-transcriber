/**
 * Video Player & Canvas Subtitle Renderer Engine
 *
 * Rendering model
 * ---------------
 * Everything is drawn at the *project* resolution (e.g. 1920x1080 for 16x9,
 * 1080x1920 for 9x16). The preview canvas is sized to the project resolution in
 * backing-store pixels and merely scaled down by CSS, so what you see in the
 * Program Monitor is pixel-for-pixel what gets written to the ProRes export.
 *
 * All style numbers in a preset (font size, margins, stroke width, shadow) are
 * expressed against a 1080-pixel-tall reference frame and scaled by
 * project.height / 1080, so a preset looks proportionally identical in every
 * aspect ratio.
 */

const ASPECT_PRESETS = {
  '16x9': { id: '16x9', label: '16:9 Landscape', width: 1920, height: 1080 },
  '1x1':  { id: '1x1',  label: '1:1 Square',     width: 1080, height: 1080 },
  '4x5':  { id: '4x5',  label: '4:5 Portrait',   width: 1080, height: 1350 },
  '9x16': { id: '9x16', label: '9:16 Vertical',  width: 1080, height: 1920 }
};

const REFERENCE_HEIGHT = 1080;

class VideoPlayerController {
  constructor(videoElement, canvasElement, subtitleManager, presetParser, fps = 25) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.subManager = subtitleManager;
    this.presetParser = presetParser;
    this.fps = fps;

    this.activePreset = this.presetParser.getPreset('netflix_clean');
    this.project = { ...ASPECT_PRESETS['16x9'] };
    this.onTimeUpdateCallbacks = [];
    this.onProjectChangeCallbacks = [];
    this.onPresetChangeCallbacks = [];

    this.hasMedia = false; // false => the built-in demo clock drives the timeline
    this.isPlaying = false;
    this.isLoopingRegion = false;
    this.isOverlayHidden = false;
    this.playbackSpeed = 1.0;
    this.syntheticTime = 0;
    this.syntheticDuration = 30.0;
    this.lastFrameTime = null;
    this.rafHandle = null;
    this.onFrameRenderCallbacks = [];

    this.applyProjectToCanvas();
    this.initEvents();
  }

  initEvents() {
    this.video.addEventListener('timeupdate', () => {
      if (!this.hasMedia) return; // the demo clock drives playback until media loads
      this.renderOverlay();
      this.emitTimeUpdate();
    });

    this.video.addEventListener('play', () => {
      this.isPlaying = true;
      this.startRenderLoop();
    });

    this.video.addEventListener('pause', () => {
      this.isPlaying = false;
      this.renderOverlay();
    });

    this.video.addEventListener('loadedmetadata', () => {
      this.renderOverlay();
      this.emitTimeUpdate();
    });

    this.video.addEventListener('seeked', () => {
      this.renderOverlay();
      this.emitTimeUpdate();
    });

    this.video.addEventListener('ended', () => {
      this.isPlaying = false;
      this.renderOverlay();
      this.emitTimeUpdate();
    });

    window.addEventListener('resize', () => {
      this.fitProgramFrame();
      this.renderOverlay();
    });

    // The viewport can change size without a window resize (panel layout,
    // fullscreen, font loading), so watch the container directly.
    const viewport = document.getElementById('viewportContainer');
    if (viewport && window.ResizeObserver) {
      this.viewportObserver = new ResizeObserver(() => this.fitProgramFrame());
      this.viewportObserver.observe(viewport);
    }
    this.fitProgramFrame();
  }

  /**
   * Sizes the program frame so it fits the viewport on BOTH axes at the exact
   * project aspect ratio. CSS `aspect-ratio` alone cannot do this: once one
   * axis is definite, a max-* clamp on the other distorts the ratio instead of
   * shrinking the frame.
   */
  fitProgramFrame() {
    const frame = document.getElementById('programFrame');
    const viewport = document.getElementById('viewportContainer');
    if (!frame || !viewport) return;

    const style = getComputedStyle(viewport);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

    const availW = Math.max(0, viewport.clientWidth - padX);
    const availH = Math.max(0, viewport.clientHeight - padY);
    if (availW <= 0 || availH <= 0) return;

    const ratio = this.project.width / this.project.height;
    let w = availW;
    let h = w / ratio;
    if (h > availH) {
      h = availH;
      w = h * ratio;
    }

    frame.style.width = `${Math.floor(w)}px`;
    frame.style.height = `${Math.floor(h)}px`;
  }

  // --- Project / Aspect Ratio ---
  getAspectPresets() {
    return ASPECT_PRESETS;
  }

  setAspectRatio(aspectId) {
    const aspect = ASPECT_PRESETS[aspectId];
    if (!aspect) return this.project;
    this.project = { ...aspect };
    this.applyProjectToCanvas();
    this.fitProgramFrame();
    this.renderOverlay();
    this.onProjectChangeCallbacks.forEach(cb => cb(this.project));
    return this.project;
  }

  onProjectChange(cb) {
    this.onProjectChangeCallbacks.push(cb);
  }

  applyProjectToCanvas() {
    // Backing store == project resolution. CSS scales it down for display.
    this.canvas.width = this.project.width;
    this.canvas.height = this.project.height;

    const frame = document.getElementById('programFrame');
    if (frame) {
      frame.style.aspectRatio = `${this.project.width} / ${this.project.height}`;
    }
  }

  /**
   * Merges, because the inspector sends the fields it owns rather than a whole
   * style. A whole style — the preset dropdown, an import, another ratio — has
   * to go through applyPreset() instead.
   */
  setPreset(presetObj) {
    if (!presetObj) return;
    // Migrated before the merge, so an older style's offset replaces the
    // current distance rather than being shadowed by it.
    this.activePreset = PresetParser.migrateShadowOffset({
      ...this.activePreset, ...PresetParser.migrateShadowOffset(presetObj)
    });
    this.renderOverlay();
    this.onPresetChangeCallbacks.forEach(cb => cb(this.activePreset));
  }

  /**
   * Swaps the whole style. Anything the incoming preset leaves unsaid falls
   * back to the preset defaults rather than to the style being replaced: a
   * Premiere import names an exact face in `fontPostScriptName`, and a merge
   * would leave that face drawing under every preset chosen afterwards, since
   * presets that never named one have no value to overwrite it with.
   */
  applyPreset(presetObj) {
    if (!presetObj) return;
    this.setPreset(this.presetParser.normalizePreset(presetObj));
  }

  /**
   * Fires for every route a style can change by — the inspector, the preset
   * dropdown, an imported .prfpset — so the film that owns the style has one
   * place to hear about it rather than four.
   */
  onPresetChange(cb) {
    this.onPresetChangeCallbacks.push(cb);
  }

  setSpeed(rate) {
    const parsed = parseFloat(rate);
    this.playbackSpeed = isNaN(parsed) || parsed <= 0 ? 1.0 : parsed;
    this.video.playbackRate = this.playbackSpeed;
    return this.playbackSpeed;
  }

  loadMedia(file, objectUrl) {
    this.pause();
    this.hasMedia = true;
    this.video.srcObject = null;
    this.video.src = objectUrl;
    this.video.load();
    this.syntheticTime = 0;
    this.renderOverlay();
  }

  /**
   * Detaches the current media and hands the timeline back to the built-in demo
   * clock. Switching to a film whose media has not been relinked goes through
   * here, so the program monitor shows the placeholder rather than the previous
   * film's picture — which would silently misrepresent what is being captioned.
   */
  unloadMedia() {
    this.pause();
    this.hasMedia = false;
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    try { this.video.load(); } catch (e) { /* nothing was loaded */ }
    this.syntheticTime = 0;
    this.renderOverlay();
    this.emitTimeUpdate();
  }

  onFrameRender(cb) {
    this.onFrameRenderCallbacks.push(cb);
  }

  onTimeUpdate(cb) {
    this.onTimeUpdateCallbacks.push(cb);
  }

  emitTimeUpdate() {
    const curr = this.getCurrentTime();
    const dur = this.getDuration();
    this.onTimeUpdateCallbacks.forEach(cb => cb(curr, dur));
  }

  // --- Transport Controls ---
  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
    return this.isPlaying;
  }

  play() {
    this.isPlaying = true;
    this.lastFrameTime = performance.now();
    if (this.hasMedia) {
      this.video.playbackRate = this.playbackSpeed;
      this.video.play().catch(() => {});
    }
    this.startRenderLoop();
  }

  pause() {
    this.isPlaying = false;
    this.lastFrameTime = null;
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.hasMedia) this.video.pause();
    this.renderOverlay();
  }

  getCurrentTime() {
    if (!this.hasMedia) return this.syntheticTime || 0;
    return this.video.currentTime || 0;
  }

  getDuration() {
    if (!this.hasMedia) return this.syntheticDuration;
    const dur = this.video.duration;
    return isFinite(dur) && dur > 0 ? dur : 60.0;
  }

  seek(seconds) {
    const dur = this.getDuration();
    const targetSec = Math.max(0, Math.min(dur, seconds));
    if (!this.hasMedia) {
      this.syntheticTime = targetSec;
    } else {
      try {
        this.video.currentTime = targetSec;
      } catch (e) { /* media not seekable yet */ }
    }
    this.renderOverlay();
    this.emitTimeUpdate();
  }

  stepFrame(framesCount = 1) {
    this.pause();
    const frameTime = 1 / this.fps;
    // Quantise to the frame grid first so repeated steps stay frame-accurate.
    const currFrame = Math.round(this.getCurrentTime() * this.fps);
    this.seek((currFrame + framesCount) * frameTime);
  }

  jumpToPrevSubtitle() {
    const curr = this.getCurrentTime();
    const subs = this.subManager.getSubtitles();
    if (subs.length === 0) return;
    const prev = [...subs].reverse().find(s => s.start < curr - 0.2);
    if (prev) {
      this.subManager.selectSubtitle(prev.id);
      this.seek(prev.start);
    } else {
      this.subManager.selectSubtitle(subs[0].id);
      this.seek(subs[0].start);
    }
  }

  jumpToNextSubtitle() {
    const curr = this.getCurrentTime();
    const subs = this.subManager.getSubtitles();
    if (subs.length === 0) return;
    const next = subs.find(s => s.start > curr + 0.2);
    if (next) {
      this.subManager.selectSubtitle(next.id);
      this.seek(next.start);
    } else {
      const last = subs[subs.length - 1];
      this.subManager.selectSubtitle(last.id);
      this.seek(last.start);
    }
  }

  toggleLoopRegion() {
    this.isLoopingRegion = !this.isLoopingRegion;
    return this.isLoopingRegion;
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    return this.video.muted;
  }

  setSolo(isSolo) {
    // "Solo" on the audio track means: audio only, hide the picture.
    this.isAudioSolo = !!isSolo;
    this.video.style.opacity = this.isAudioSolo ? '0' : '1';
    this.renderOverlay();
    return this.isAudioSolo;
  }

  toggleSolo() {
    return this.setSolo(!this.isAudioSolo);
  }

  toggleOverlayHide() {
    this.isOverlayHidden = !this.isOverlayHidden;
    this.renderOverlay();
    return this.isOverlayHidden;
  }

  toggleFullscreen() {
    const container = document.getElementById('viewportContainer');
    if (!document.fullscreenElement) {
      if (container && container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      }
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  startRenderLoop() {
    if (!this.isPlaying) return;

    const now = performance.now();
    if (this.lastFrameTime !== null) {
      const deltaSec = (now - this.lastFrameTime) / 1000;
      if (!this.hasMedia && deltaSec > 0) {
        this.syntheticTime = (this.syntheticTime || 0) + (deltaSec * this.playbackSpeed);
        if (this.syntheticTime >= this.getDuration()) this.syntheticTime = 0;
      }
    }
    this.lastFrameTime = now;

    // Region looping over the selected caption
    if (this.isLoopingRegion && this.subManager.selectedId) {
      const activeSub = this.subManager.getSubtitles().find(s => s.id === this.subManager.selectedId);
      if (activeSub) {
        const curr = this.getCurrentTime();
        if (curr >= activeSub.end || curr < activeSub.start - 0.05) {
          this.seek(activeSub.start);
        }
      }
    }

    this.renderOverlay();
    this.emitTimeUpdate();

    this.rafHandle = requestAnimationFrame(() => this.startRenderLoop());
  }

  // --- Overlay Rendering ---
  renderOverlay() {
    const currentTime = this.getCurrentTime();
    this.onFrameRenderCallbacks.forEach(cb => cb(currentTime, this.project));

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.isOverlayHidden) return;
    this.drawSubtitleFrame(ctx, currentTime, this.project, this.activePreset);
  }

  /**
   * Draws the caption for `currentTime` onto `ctx` at the given project size.
   * Leaves every pixel it does not touch fully transparent — this is exactly
   * what the alpha ProRes export renders, so preview and export cannot drift.
   *
   * Returns the frame's signature: everything time-dependent the drawing used
   * (null for an empty frame). Two frames with equal signatures are identical
   * pixel for pixel, which lets the export skip re-encoding held captions.
   */
  drawSubtitleFrame(ctx, currentTime, project, preset) {
    const w = project.width;
    const h = project.height;
    const activeSub = this.subManager.getActiveSubtitleAt(currentTime);
    if (!activeSub || !activeSub.text.trim()) return null;
    // Three layers: the ratio's style, the speaker's changes to it (a colour
    // per person), and the caption's own (a different face for a sign, a move
    // to the top over a lower third).
    preset = PresetParser.migrateShadowOffset(this.subManager.styleFor(activeSub, preset));

    // The speaker's name goes into the text itself, before wrapping, so it
    // wraps, boxes, strokes and casts a shadow exactly as the words do. Only
    // the fill pass needs to know which words are the name, to colour them.
    let text = activeSub.text.trim();
    let labelWords = 0;
    const label = this.subManager.speakerLabelFor(activeSub, preset);
    if (label) {
      const name = preset.speakerLabel === 'prefix' ? `${label}:` : label;
      text = preset.speakerLabel === 'prefix' ? `${name} ${text}` : `${name}\n${text}`;
      labelWords = name.split(/\s+/).filter(Boolean).length;
    }
    if (preset.textUppercase) text = text.toUpperCase();

    const scaleFactor = h / REFERENCE_HEIGHT;
    const fontSize = Math.max(1, Math.round((preset.fontSize || 54) * scaleFactor));
    const fontStyle = preset.fontStyleItalic ? 'italic ' : '';
    const fontWeight = preset.fontWeightBold ? 'bold ' : 'normal ';

    ctx.save();
    // Premiere names the exact face ("Specsavers-Regular"), which the font
    // loader registers under that name. Prefer it over the family so the right
    // weight is drawn rather than a synthesised one.
    const family = preset.fontPostScriptName || preset.fontFamily;
    ctx.font = `${fontStyle}${fontWeight}${fontSize}px "${family}", "${preset.fontFamily}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Tracking is authored in 1/1000 em, the same unit Premiere shows.
    const trackingPx = ((preset.letterSpacing || 0) / 1000) * fontSize;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${trackingPx}px`;

    // How far across the frame a line may run before it wraps, as a share of
    // the frame width. Left and right alignment sit on the edge of that box,
    // so the side margin and the wrap width are the same setting.
    const widthPct = preset.textWidth > 0 ? Math.min(100, preset.textWidth) : 85;
    const maxTextWidth = w * (widthPct / 100);
    const sideMargin = (w - maxTextWidth) / 2;
    const lines = this.wrapText(ctx, text, maxTextWidth);
    const lineHeight = fontSize * (preset.lineHeight > 0 ? preset.lineHeight : 1.25);
    const totalTextHeight = lines.length * lineHeight;

    const margin = (preset.bottomMargin || 50) * scaleFactor;
    const align = preset.align || 'bottom-center';

    // Horizontal placement
    let posX = w / 2;
    if (align.includes('left')) {
      posX = sideMargin;
      ctx.textAlign = 'left';
    } else if (align.includes('right')) {
      posX = w - sideMargin;
      ctx.textAlign = 'right';
    }

    // Vertical placement (posY is the vertical CENTRE of the text block)
    let posY;
    if (align.startsWith('top')) {
      posY = margin + (totalTextHeight / 2);
    } else if (align.startsWith('bottom')) {
      posY = h - margin - (totalTextHeight / 2);
    } else {
      posY = h / 2; // center-left / center / center-right
    }

    // Premiere's Align and Transform nudges the block off its zone by a pixel
    // offset — the pair its Position field shows, positive Y downwards. Both
    // axes scale by the frame's height so the nudge survives a ratio change,
    // and at 1080 the numbers are Premiere's own, one for one.
    posX += (preset.offsetX || 0) * scaleFactor;
    posY += (preset.offsetY || 0) * scaleFactor;

    // Animation
    let animAlpha = 1.0;
    let animScale = 1.0;
    if (preset.animationPreset === 'fade') {
      const fadeIn = Math.min(1.0, (currentTime - activeSub.start) / 0.2);
      const fadeOut = Math.min(1.0, (activeSub.end - currentTime) / 0.2);
      animAlpha = Math.max(0, Math.min(fadeIn, fadeOut));
    } else if (preset.animationPreset === 'pop') {
      const elapsed = currentTime - activeSub.start;
      if (elapsed < 0.15) animScale = 0.8 + (Math.max(0, elapsed) / 0.15) * 0.2;
    }

    ctx.globalAlpha = animAlpha;
    if (animScale !== 1.0) {
      ctx.translate(posX, posY);
      ctx.scale(animScale, animScale);
      ctx.translate(-posX, -posY);
    }

    const shadowEnabled = !!preset.enableShadow;
    // Premiere's Shadow: Angle is the direction the shadow is thrown, clockwise
    // from straight up, so 135 falls down and to the right; Size grows the
    // shape before it is blurred.
    const shadowAngle = ((preset.shadowAngle !== undefined ? preset.shadowAngle : 180) * Math.PI) / 180;
    const shadowDistance = (preset.shadowDistance || 0) * scaleFactor;
    const shadowSpread = (preset.shadowSize || 0) * scaleFactor;
    const shadowAlpha = (preset.shadowOpacity !== undefined ? preset.shadowOpacity : 100) / 100;

    // Canvas only casts the shadow of something it draws, and has no spread.
    // So the shape — fattened by Size — is drawn a long way off the left of
    // the frame and only its shadow is thrown back on. The shadow offset is in
    // device pixels and ignores the transform, hence the device-space shift.
    const drawShadow = (paintShape) => {
      const throwPx = ctx.canvas.width * 3;
      const m = ctx.getTransform();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, -throwPx, 0);
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.shadowColor = this.hexToRgba(preset.shadowColor || '#000000', shadowAlpha);
      ctx.shadowBlur = (preset.shadowBlur || 0) * scaleFactor;
      ctx.shadowOffsetX = throwPx + Math.sin(shadowAngle) * shadowDistance;
      ctx.shadowOffsetY = -Math.cos(shadowAngle) * shadowDistance;
      ctx.fillStyle = ctx.strokeStyle = '#000000';
      ctx.lineJoin = 'round';
      paintShape();
      ctx.restore();
    };

    // Background box behind the whole text block (Premiere-style)
    if (preset.enableBgBox) {
      const padding = (preset.bgBoxPadding || 12) * scaleFactor;
      let maxLineWidth = 0;
      lines.forEach(l => {
        const mw = ctx.measureText(l).width;
        if (mw > maxLineWidth) maxLineWidth = mw;
      });

      const boxWidth = maxLineWidth + (padding * 2);
      const boxHeight = totalTextHeight + (padding * 2);

      let boxX = posX - (boxWidth / 2);
      if (ctx.textAlign === 'left') boxX = posX - padding;
      if (ctx.textAlign === 'right') boxX = posX - maxLineWidth - padding;

      const boxY = posY - (totalTextHeight / 2) - padding;

      const boxAlpha = (preset.bgBoxOpacity !== undefined ? preset.bgBoxOpacity : 60) / 100;
      if (shadowEnabled) {
        drawShadow(() => {
          // A see-through box casts a lighter shadow, as it did before.
          ctx.globalAlpha *= boxAlpha;
          this.drawRoundedRect(ctx, boxX - shadowSpread, boxY - shadowSpread,
            boxWidth + shadowSpread * 2, boxHeight + shadowSpread * 2, 6 * scaleFactor + shadowSpread);
          ctx.fill();
        });
      }
      ctx.fillStyle = this.hexToRgba(preset.bgBoxColor, boxAlpha);
      this.drawRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 6 * scaleFactor);
      ctx.fill();
    }

    const strokeOn = !!preset.enableStroke && (preset.strokeWidth || 0) > 0;
    // Premiere draws the stroke *outside* the glyph. Canvas centres it on the
    // path, so double the width and paint it before the fill.
    const strokePx = (preset.strokeWidth || 0) * scaleFactor * 2;

    const lineYAt = (lineIndex) => posY - (totalTextHeight / 2) + (lineIndex * lineHeight) + (lineHeight / 2);

    // Every line's shadow goes down before any text, so a long shadow from
    // one line never lands on top of the line below it.
    if (shadowEnabled && !preset.enableBgBox) {
      const outline = (strokeOn ? strokePx : 0) + shadowSpread * 2;
      drawShadow(() => {
        lines.forEach((lineStr, lineIndex) => {
          const lineY = lineYAt(lineIndex);
          if (outline > 0) {
            ctx.lineWidth = outline;
            ctx.strokeText(lineStr, posX, lineY);
          }
          ctx.fillText(lineStr, posX, lineY);
        });
      });
    }

    let wordOffset = 0;
    const totalWords = lines.reduce((n, l) => n + l.split(/\s+/).filter(Boolean).length, 0);
    let activeWordIdx = -1;
    if (preset.animationPreset === 'karaoke') {
      // The highlight walks the spoken words only; the name is not read out.
      const spoken = Math.max(1, totalWords - labelWords);
      const duration = Math.max(0.001, activeSub.end - activeSub.start);
      const progress = Math.min(1.0, Math.max(0, (currentTime - activeSub.start) / duration));
      activeWordIdx = labelWords + Math.min(spoken - 1, Math.floor(progress * spoken));
    }
    const fillColor = preset.fillColor || '#ffffff';
    const labelColor = labelWords && preset.speakerLabelColor
      && preset.speakerLabelColor.toLowerCase() !== fillColor.toLowerCase()
      ? preset.speakerLabelColor : null;

    lines.forEach((lineStr, lineIndex) => {
      const lineY = lineYAt(lineIndex);

      if (strokeOn) {
        ctx.strokeStyle = preset.strokeColor || '#000000';
        ctx.lineWidth = strokePx;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.strokeText(lineStr, posX, lineY);
      }

      const lineWords = lineStr.split(/\s+/).filter(Boolean).length;
      if (preset.animationPreset === 'karaoke') {
        this.renderKaraokeLine(ctx, lineStr, posX, lineY, preset, scaleFactor, wordOffset, activeWordIdx,
          labelWords, labelColor);
      } else if (labelColor && wordOffset < labelWords) {
        this.renderLabelledLine(ctx, lineStr, posX, lineY, labelWords - wordOffset, labelColor, fillColor);
      } else {
        ctx.fillStyle = fillColor;
        ctx.fillText(lineStr, posX, lineY);
      }
      wordOffset += lineWords;
    });

    ctx.restore();
    return { sub: activeSub, alpha: animAlpha, scale: animScale, word: activeWordIdx };
  }

  /** Left edge of a line drawn at posX under the context's current alignment. */
  lineStartX(ctx, lineStr, posX) {
    if (ctx.textAlign === 'center') return posX - (ctx.measureText(lineStr).width / 2);
    if (ctx.textAlign === 'right') return posX - ctx.measureText(lineStr).width;
    return posX;
  }

  /**
   * A line whose first `nameWords` words are the speaker's name, filled in the
   * label colour, and the rest in the text colour. Drawn as two runs from the
   * line's own left edge so the pair lands exactly where the whole line would.
   */
  renderLabelledLine(ctx, lineStr, posX, lineY, nameWords, labelColor, fillColor) {
    const words = lineStr.split(' ');
    const head = words.slice(0, nameWords).join(' ');
    const tail = words.slice(nameWords).join(' ');
    ctx.save();
    const x = this.lineStartX(ctx, lineStr, posX);
    ctx.textAlign = 'left';
    ctx.fillStyle = labelColor;
    ctx.fillText(head, x, lineY);
    if (tail) {
      ctx.fillStyle = fillColor;
      ctx.fillText(tail, x + ctx.measureText(head + ' ').width, lineY);
    }
    ctx.restore();
  }

  renderKaraokeLine(ctx, lineStr, posX, lineY, preset, scaleFactor, wordOffset, activeWordIdx,
    labelWords = 0, labelColor = null) {
    const words = lineStr.split(' ');

    ctx.save();
    let currentX = posX;
    if (ctx.textAlign === 'center') {
      currentX = posX - (ctx.measureText(lineStr).width / 2);
    } else if (ctx.textAlign === 'right') {
      currentX = posX - ctx.measureText(lineStr).width;
    }
    ctx.textAlign = 'left';

    let globalIdx = wordOffset;
    words.forEach((word, wIdx) => {
      const wordStr = word + (wIdx < words.length - 1 ? ' ' : '');
      if (word.trim()) {
        if (globalIdx < labelWords) {
          ctx.fillStyle = labelColor || preset.fillColor || '#ffffff';
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
        } else if (globalIdx === activeWordIdx) {
          ctx.fillStyle = preset.karaokeColor || '#00ffff';
          ctx.shadowColor = preset.karaokeColor || '#00ffff';
          ctx.shadowBlur = 12 * scaleFactor;
        } else {
          ctx.fillStyle = preset.fillColor || '#ffffff';
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
        }
        globalIdx++;
      }
      ctx.fillText(wordStr, currentX, lineY);
      currentX += ctx.measureText(wordStr).width;
    });
    ctx.restore();
  }

  /** Honours hard line breaks in the caption, then word-wraps each of them. */
  wrapText(ctx, text, maxWidth) {
    const out = [];
    text.split(/\r?\n/).forEach(paragraph => {
      const words = paragraph.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        out.push('');
        return;
      }
      let currentLine = '';
      words.forEach(word => {
        const candidate = currentLine ? currentLine + ' ' + word : word;
        if (ctx.measureText(candidate).width <= maxWidth) {
          currentLine = candidate;
          return;
        }
        if (currentLine) {
          out.push(currentLine);
          currentLine = '';
        }
        // A single word wider than the frame would otherwise run off both
        // edges, so break it across lines by character.
        if (ctx.measureText(word).width > maxWidth) {
          let chunk = '';
          for (const ch of word) {
            if (chunk && ctx.measureText(chunk + ch).width > maxWidth) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          currentLine = chunk;
        } else {
          currentLine = word;
        }
      });
      if (currentLine) out.push(currentLine);
    });
    return out.length ? out : [''];
  }

  drawRoundedRect(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  hexToRgba(hex, alpha = 1) {
    if (!hex) return `rgba(0, 0, 0, ${alpha})`;
    if (hex.startsWith('rgb')) return hex;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    if (isNaN(num)) return `rgba(0, 0, 0, ${alpha})`;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

window.ASPECT_PRESETS = ASPECT_PRESETS;
window.VideoPlayerController = VideoPlayerController;
