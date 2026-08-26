/**
 * Saved caption styles — the presets imported from Premiere or saved off the
 * inspector, kept between launches.
 *
 * A Premiere preset lives in a file outside this app, often on the drive of the
 * machine that made it, so a style imported once was previously re-imported on
 * every launch. This store keeps the parsed style objects in localStorage and
 * hands them back to the preset dropdown at boot.
 *
 * Entries carry `source` — 'premiere' when parsed from a preset file, 'custom'
 * when saved off the inspector — the original file name where there was one,
 * and when it was saved. Re-importing the same file replaces its entry instead
 * of stacking another copy beside it, so the list stays a library of styles
 * rather than a log of every import.
 */

class PresetLibrary {
  constructor(storageKey = 'transcriber.presets.library') {
    this.key = storageKey;
    this.entries = this._read();
    // False once a write has been refused (private mode, quota). The caller
    // says so rather than letting the operator believe a style was kept.
    this.lastWriteOk = true;
  }

  _read() {
    try {
      const raw = localStorage.getItem(this.key);
      const parsed = raw ? JSON.parse(raw) : [];
      // An id is what the dropdown and the film records address a style by; an
      // entry without one is unreachable, so it is dropped rather than shown.
      return Array.isArray(parsed) ? parsed.filter(p => p && p.id && p.name) : [];
    } catch (e) {
      return []; // private mode, or a store written by an older build
    }
  }

  /** @returns {boolean} false when the browser refused the write (private mode, quota). */
  _write() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.entries));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Newest first — the style just imported is the one being looked for. */
  list() { return this.entries.slice(); }

  get(id) { return this.entries.find(p => p.id === id) || null; }

  /**
   * @param {Object} preset a parsed style object
   * @param {Object} meta   { source: 'premiere'|'custom', fileName }
   * @returns {Object} the stored entry — its id is the authoritative one
   */
  save(preset, meta = {}) {
    const source = meta.source === 'premiere' ? 'premiere' : 'custom';
    const fileName = meta.fileName || '';
    const name = String(preset.name || '').trim() || 'Untitled style';

    // Same file imported twice, or a style re-saved under a name already in the
    // library: replace it in place. Matching on the file name first means a
    // renamed entry still recognises its own file on re-import.
    const existing = this.entries.find(p =>
      p.source === source && (
        (fileName && p.fileName === fileName) ||
        (!fileName && p.name.toLowerCase() === name.toLowerCase())));

    const entry = {
      ...preset,
      name,
      id: existing ? existing.id : PresetLibrary.newId(source),
      source,
      fileName: fileName || (existing ? existing.fileName : ''),
      savedAt: new Date().toISOString()
    };

    if (existing) this.entries[this.entries.indexOf(existing)] = entry;
    else this.entries.unshift(entry);
    this.lastWriteOk = this._write();
    return entry;
  }

  rename(id, name) {
    const entry = this.get(id);
    const clean = String(name || '').trim();
    if (!entry || !clean) return null;
    entry.name = clean;
    this.lastWriteOk = this._write();
    return entry;
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter(p => p.id !== id);
    if (this.entries.length === before) return false;
    this.lastWriteOk = this._write();
    return true;
  }

  static newId(source) {
    const stem = source === 'premiere' ? 'prem' : 'custom';
    return `${stem}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
}

window.PresetLibrary = PresetLibrary;
