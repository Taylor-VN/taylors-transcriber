/**
 * Project, Film & Ratio model.
 *
 * A *project* is one job — a client deliverable, a campaign, an episode.
 * Inside it sits a list of *films*: the separate edits delivered for that job,
 * each with its own media and its own transcription.
 *
 * A film is not tied to an aspect ratio. Every film carries a *ratio variant*
 * for each deliverable shape, and each variant holds its own captions, caption
 * style and safe-area guides. That is the point: one edit is cut for 16:9 and
 * for 9:16, and the same words have to be re-flowed for each frame — shorter
 * lines and a higher margin in vertical, longer lines in landscape. So the
 * captions are edited per ratio and the film exports in every ratio.
 *
 * Generated captions (a transcription, an imported SRT) are written to every
 * ratio at once, because they come from one soundtrack. Hand edits — typing,
 * splitting, dragging a clip — only touch the ratio being edited.
 *
 * This class owns only serialisable state. Live File handles, object URLs and
 * decoded waveforms are session-only and live beside it in app.js, keyed by
 * film id: a project file has to stay a few hundred kilobytes of text, not a
 * copy of the rushes.
 */

const PROJECT_FORMAT = 'taylors-transcriber-project';
const PROJECT_VERSION = 2;
const PROJECT_EXT = '.ttproj';

// Must match ASPECT_PRESETS in videoPlayer.js. Order is the tab order.
const RATIO_IDS = ['16x9', '1x1', '4x5', '9x16'];

function projectUid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

class ProjectManager {
  /**
   * @param {Object} opts
   * @param {number} opts.fps
   * @param {Object} opts.defaultPreset  style a brand-new ratio starts from
   */
  constructor(opts = {}) {
    this.fps = opts.fps || 25;
    // Project-wide timing. `frameRate` is an id from FRAME_RATES (so 29.97 DF and
    // NDF stay distinct); `fps` above is only the nominal number, kept for
    // readers of older files.
    this.frameRate = opts.frameRate || '25';
    this.startTimecode = opts.startTimecode || '00:00:00:00';
    this.defaultPreset = opts.defaultPreset || {};
    this.listeners = [];
    this.reset({ silent: true });
  }

  // --- change notification ---------------------------------------------
  onChange(cb) {
    this.listeners.push(cb);
  }

  notify() {
    this.listeners.forEach(cb => cb(this));
  }

  markDirty() {
    if (this.dirty) return;
    this.dirty = true;
    this.notify();
  }

  markSaved(path) {
    this.dirty = false;
    if (path !== undefined) this.path = path || '';
    this.savedAt = new Date().toISOString();
    this.notify();
  }

  // --- lifecycle --------------------------------------------------------
  reset(opts = {}) {
    this.name = opts.name || 'Untitled Project';
    this.path = '';
    this.createdAt = new Date().toISOString();
    this.savedAt = null;
    this.films = [];
    this.activeId = null;

    const first = this.makeFilm({ name: 'Film 1' });
    this.films.push(first);
    this.activeId = first.id;
    this.dirty = false;

    if (!opts.silent) this.notify();
    return this;
  }

  /** One deliverable shape within a film: its captions, its style, its guides. */
  makeRatio(init = {}) {
    return {
      subtitles: Array.isArray(init.subtitles) ? init.subtitles.map(s => ({ ...s })) : [],
      selectedId: init.selectedId || null,
      preset: init.preset ? { ...init.preset } : { ...this.defaultPreset },
      guides: init.guides || 'generic'
    };
  }

  /** A blank film record. Everything a film owns is on this object. */
  makeFilm(init = {}) {
    const ratios = {};
    RATIO_IDS.forEach(id => {
      ratios[id] = this.makeRatio((init.ratios && init.ratios[id]) || {});
    });

    return {
      id: init.id || projectUid('film'),
      name: init.name || `Film ${this.films.length + 1}`,
      ratios: ratios,
      activeRatio: RATIO_IDS.includes(init.activeRatio) ? init.activeRatio : '16x9',
      // Descriptor only — the File itself cannot live in a text project file,
      // so re-opening a project asks for the media to be relinked.
      media: init.media ? { ...init.media } : null,
      // The raw transcription, kept so the segmentation sliders can re-cut it
      // in a later session without paying for another model run. It belongs to
      // the film, not a ratio: there is one soundtrack.
      transcription: init.transcription || null,
      segment: {
        maxCharsPerLine: 42,
        maxLines: 2,
        maxDurationSec: 6,
        ...(init.segment || {})
      },
      zoom: init.zoom || 50,
      playhead: init.playhead || 0
    };
  }

  // --- film CRUD --------------------------------------------------------
  getFilms() {
    return this.films;
  }

  getFilm(id) {
    return this.films.find(f => f.id === id) || null;
  }

  getActive() {
    return this.getFilm(this.activeId) || this.films[0] || null;
  }

  /** The ratio variant currently being edited in the given (or active) film. */
  getRatio(film, ratioId) {
    const target = film || this.getActive();
    if (!target) return null;
    return target.ratios[ratioId || target.activeRatio] || null;
  }

  getActiveRatio() {
    return this.getRatio(this.getActive());
  }

  setActiveRatio(ratioId) {
    const film = this.getActive();
    if (!film || !film.ratios[ratioId] || film.activeRatio === ratioId) return false;
    film.activeRatio = ratioId;
    this.notify();
    return true;
  }

  activeIndex() {
    return Math.max(0, this.films.findIndex(f => f.id === this.activeId));
  }

  addFilm(init = {}) {
    const film = this.makeFilm(init);
    this.films.push(film);
    this.dirty = true;
    this.notify();
    return film;
  }

  /** A full copy — every ratio's captions and style — as an independent edit. */
  duplicateFilm(id) {
    const src = this.getFilm(id);
    if (!src) return null;

    const ratios = {};
    RATIO_IDS.forEach(rid => {
      const from = src.ratios[rid];
      ratios[rid] = this.makeRatio({
        ...from,
        // Fresh caption ids: two films must never share one, or selecting a
        // line in one would highlight a line in the other.
        subtitles: from.subtitles.map((s, i) => ({ ...s, id: `sub_${projectUid('c')}_${i}` })),
        selectedId: null
      });
    });

    const copy = this.makeFilm({
      ...src,
      id: null,
      name: this.uniqueName(`${src.name} copy`),
      ratios: ratios
    });

    this.films.splice(this.films.indexOf(src) + 1, 0, copy);
    this.dirty = true;
    this.notify();
    return copy;
  }

  removeFilm(id) {
    if (this.films.length <= 1) return false; // a project always holds one film
    const idx = this.films.findIndex(f => f.id === id);
    if (idx === -1) return false;

    this.films.splice(idx, 1);
    if (this.activeId === id) {
      this.activeId = this.films[Math.min(idx, this.films.length - 1)].id;
    }
    this.dirty = true;
    this.notify();
    return true;
  }

  renameFilm(id, name) {
    const film = this.getFilm(id);
    const clean = String(name || '').trim();
    if (!film || !clean || clean === film.name) return false;
    film.name = this.uniqueName(clean, id);
    this.dirty = true;
    this.notify();
    return true;
  }

  /** Tab strips are unreadable when two tabs carry the same word. */
  uniqueName(wanted, exceptId) {
    const taken = new Set(this.films.filter(f => f.id !== exceptId).map(f => f.name));
    if (!taken.has(wanted)) return wanted;
    let n = 2;
    while (taken.has(`${wanted} ${n}`)) n++;
    return `${wanted} ${n}`;
  }

  setActive(id) {
    if (!this.getFilm(id) || id === this.activeId) return false;
    this.activeId = id;
    this.notify();
    return true;
  }

  /** Step through the tab strip. Wraps, so `]` on the last film lands on the first. */
  stepActive(delta) {
    if (this.films.length < 2) return null;
    const next = (this.activeIndex() + delta + this.films.length) % this.films.length;
    const film = this.films[next];
    this.setActive(film.id);
    return film;
  }

  moveFilm(id, delta) {
    const idx = this.films.findIndex(f => f.id === id);
    const target = idx + delta;
    if (idx === -1 || target < 0 || target >= this.films.length) return false;
    const [film] = this.films.splice(idx, 1);
    this.films.splice(target, 0, film);
    this.dirty = true;
    this.notify();
    return true;
  }

  setName(name) {
    const clean = String(name || '').trim();
    if (!clean || clean === this.name) return false;
    this.name = clean;
    this.dirty = true;
    this.notify();
    return true;
  }

  // --- cross-ratio operations -------------------------------------------
  /**
   * Writes one caption list into every ratio of a film, giving each ratio its
   * own copy with its own ids. This is the path a transcription or an imported
   * subtitle file takes: one soundtrack, so every deliverable starts from the
   * same words and is re-flowed from there.
   */
  setCaptionsAllRatios(filmId, captions) {
    const film = this.getFilm(filmId);
    if (!film) return 0;
    RATIO_IDS.forEach(rid => {
      film.ratios[rid].subtitles = captions.map((sub, i) => ({
        ...sub,
        id: `sub_${projectUid(rid)}_${i}`
      }));
      film.ratios[rid].selectedId = null;
    });
    this.dirty = true;
    return RATIO_IDS.length;
  }

  /** Pushes one ratio's captions over the others — the "re-flow from here" tool. */
  copyCaptionsToOtherRatios(filmId, fromRatioId) {
    const film = this.getFilm(filmId);
    const from = film && film.ratios[fromRatioId];
    if (!from) return 0;
    let touched = 0;
    RATIO_IDS.forEach(rid => {
      if (rid === fromRatioId) return;
      film.ratios[rid].subtitles = from.subtitles.map((sub, i) => ({
        ...sub,
        id: `sub_${projectUid(rid)}_${i}`
      }));
      film.ratios[rid].selectedId = null;
      touched++;
    });
    this.dirty = true;
    this.notify();
    return touched;
  }

  copyStyleToOtherRatios(filmId, fromRatioId) {
    const film = this.getFilm(filmId);
    const from = film && film.ratios[fromRatioId];
    if (!from) return 0;
    let touched = 0;
    RATIO_IDS.forEach(rid => {
      if (rid === fromRatioId) return;
      film.ratios[rid].preset = { ...from.preset };
      touched++;
    });
    this.dirty = true;
    this.notify();
    return touched;
  }

  /** Ratios of a film that actually carry captions — what "export all" means. */
  populatedRatios(filmId) {
    const film = this.getFilm(filmId);
    if (!film) return [];
    return RATIO_IDS.filter(rid => film.ratios[rid].subtitles.length > 0);
  }

  captionCount(filmId, ratioId) {
    const film = this.getFilm(filmId);
    if (!film) return 0;
    const ratio = film.ratios[ratioId];
    return ratio ? ratio.subtitles.length : 0;
  }

  /** Films whose media descriptor has no live file attached in this session. */
  unlinkedFilms(hasFile) {
    return this.films.filter(f => f.media && f.media.name && !hasFile(f.id));
  }

  // --- serialisation ----------------------------------------------------
  /**
   * Per-caption `words` arrays are dropped: they are re-derivable from the
   * stored transcription and would multiply the file size for no gain. The
   * `uncertain` list the review filter reads is small, so it stays.
   */
  toJSON() {
    const ratioJson = (ratio) => ({
      preset: ratio.preset,
      guides: ratio.guides,
      selectedId: ratio.selectedId,
      subtitles: ratio.subtitles.map(s => ({
        id: s.id,
        start: s.start,
        end: s.end,
        text: s.text,
        speaker: s.speaker || '',
        uncertain: s.uncertain && s.uncertain.length ? s.uncertain : undefined
      }))
    });

    return {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      name: this.name,
      fps: this.fps,
      frameRate: this.frameRate,
      startTimecode: this.startTimecode,
      createdAt: this.createdAt,
      savedAt: new Date().toISOString(),
      activeFilmId: this.activeId,
      films: this.films.map(f => {
        const ratios = {};
        RATIO_IDS.forEach(rid => { ratios[rid] = ratioJson(f.ratios[rid]); });
        return {
          id: f.id,
          name: f.name,
          activeRatio: f.activeRatio,
          media: f.media,
          segment: f.segment,
          zoom: f.zoom,
          playhead: f.playhead,
          transcription: f.transcription,
          ratios: ratios
        };
      })
    };
  }

  serialize() {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  /**
   * Format 1 gave each film a single aspect ratio with one caption list. The
   * captions belong to the soundtrack, not the frame, so they are copied into
   * every ratio and the film's old ratio becomes the one it opens on — the
   * project reads the same as it did and gains the other three shapes.
   */
  static migrateV1Film(film) {
    const ratios = {};
    RATIO_IDS.forEach(rid => {
      ratios[rid] = {
        subtitles: (film.subtitles || []).map((s, i) => ({ ...s, id: `sub_${rid}_${i}` })),
        selectedId: null,
        preset: film.preset,
        guides: 'generic'
      };
    });
    return {
      ...film,
      ratios: ratios,
      activeRatio: RATIO_IDS.includes(film.aspectId) ? film.aspectId : '16x9',
      subtitles: undefined,
      preset: undefined,
      aspectId: undefined
    };
  }

  /**
   * Replaces the whole project from parsed JSON. Throws with a readable message
   * rather than half-loading something that is not one of our files.
   */
  load(data) {
    if (!data || typeof data !== 'object' || data.format !== PROJECT_FORMAT) {
      throw new Error('That file is not a Taylor\'s Transcriber project.');
    }
    const version = Number(data.version) || 1;
    if (version > PROJECT_VERSION) {
      throw new Error(
        `This project was written by a newer version of the app (format ${version}). Update before opening it.`);
    }
    if (!Array.isArray(data.films) || data.films.length === 0) {
      throw new Error('That project file contains no films.');
    }

    this.name = data.name || 'Untitled Project';
    // Projects from before the rate was a setting have neither field: 25, zero start.
    this.frameRate = (typeof getFrameRate === 'function' && data.frameRate
      && getFrameRate(data.frameRate).id === String(data.frameRate)) ? String(data.frameRate) : '25';
    this.fps = Number(data.fps) || 25;
    this.startTimecode = typeof data.startTimecode === 'string' ? data.startTimecode : '00:00:00:00';
    this.createdAt = data.createdAt || new Date().toISOString();
    this.savedAt = data.savedAt || null;
    this.films = [];
    data.films.forEach(f => {
      this.films.push(this.makeFilm(version < 2 ? ProjectManager.migrateV1Film(f) : f));
    });

    this.activeId = this.getFilm(data.activeFilmId) ? data.activeFilmId : this.films[0].id;
    this.dirty = false;
    this.notify();
    return this;
  }

  /** Filesystem-safe stem for the project file and for export filenames. */
  static slug(text, fallback = 'untitled') {
    const clean = String(text || '')
      .trim()
      .replace(/[^\w\-. ]+/g, '')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._]+|[._]+$/g, '');
    return clean || fallback;
  }
}

window.ProjectManager = ProjectManager;
window.PROJECT_EXT = PROJECT_EXT;
window.PROJECT_FORMAT = PROJECT_FORMAT;
window.RATIO_IDS = RATIO_IDS;
