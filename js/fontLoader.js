/**
 * Installed-font loader.
 *
 * Canvas can only draw a family the document has actually loaded. Premiere
 * captions routinely use licensed brand faces ("Specsavers-Regular") that are
 * installed on the machine but are not web fonts, so an imported style would
 * silently fall back to sans-serif — the single biggest reason a preset looks
 * wrong after import.
 *
 * This asks the backend for the font file, registers it with the FontFace API
 * under its PostScript name, and reports whether it succeeded so the UI can say
 * so plainly rather than quietly drawing the wrong typeface.
 */

class FontLoader {
  constructor() {
    this.loaded = new Map();   // requested name -> {family, ok}
    this.pending = new Map();
    this.families = null;
  }

  async api() {
    if (window.bridgeReady) { try { await window.bridgeReady; } catch (e) { /* static mode */ } }
    return (window.pywebview && window.pywebview.api) || null;
  }

  /**
   * Family names of every installed font, for the typography dropdown.
   *
   * An empty answer is never cached: it means the backend was not reachable
   * yet, and the next caller — opening the dropdown — should ask again rather
   * than be told for the rest of the session that no fonts exist.
   */
  async listFamilies() {
    if (this.families && this.families.length) return this.families;
    const api = await this.api();
    if (!api || !api.fonts_list) return [];
    try {
      const res = await api.fonts_list(false);
      const families = (res && res.ok && res.families) ? res.families : [];
      if (families.length) this.families = families;
      return families;
    } catch (e) {
      return [];
    }
  }

  /**
   * Ensures `name` is drawable. Resolves to {ok, family} where `family` is the
   * string to put in ctx.font — the registered PostScript name on success, or
   * the original request when the font is not installed.
   */
  async ensure(name) {
    const wanted = String(name || '').trim();
    if (!wanted) return { ok: false, family: '' };
    if (this.loaded.has(wanted)) return this.loaded.get(wanted);
    if (this.pending.has(wanted)) return this.pending.get(wanted);

    const job = this._load(wanted).then((result) => {
      this.loaded.set(wanted, result);
      this.pending.delete(wanted);
      return result;
    });
    this.pending.set(wanted, job);
    return job;
  }

  async _load(wanted) {
    // Already registered by the page itself (a web font, or an earlier call)?
    if (this._documentDeclares(wanted)) return { ok: true, family: wanted, source: 'document' };

    // Nor is there anything to do when the platform already draws the family by
    // name, which is the normal case for a font chosen from the installed list.
    // Fetching it anyway means base64-ing the whole file across the js_api
    // bridge — several megabytes for a .ttc collection — and parsing it on the
    // main thread, which freezes the window for seconds.
    if (FontLoader.rendersLocally(wanted)) {
      return { ok: true, family: wanted, source: 'renderable' };
    }

    const api = await this.api();
    if (!api || !api.font_resolve) return { ok: false, family: wanted, source: 'no-bridge' };

    let res;
    try {
      res = await api.font_resolve(wanted);
    } catch (e) {
      return { ok: false, family: wanted, source: 'error', error: String(e) };
    }
    if (!res || !res.ok || !res.data) {
      return { ok: false, family: wanted, source: 'not-installed' };
    }

    try {
      const bytes = FontLoader.base64ToBytes(res.data);
      // Register under the PostScript name so ctx.font lookups are exact; a
      // family+style pair would re-introduce the weight guessing we want gone.
      const family = res.postscript || res.family || wanted;
      const face = new FontFace(family, bytes.buffer);
      await face.load();
      document.fonts.add(face);

      // Also register the bare family so styles that name it still resolve.
      if (res.family && res.family !== family && !this._documentDeclares(res.family)) {
        try {
          const alias = new FontFace(res.family, bytes.buffer);
          await alias.load();
          document.fonts.add(alias);
        } catch (e) { /* alias is a convenience, not a requirement */ }
      }

      return { ok: true, family, source: 'system', path: res.path,
               postscript: res.postscript, subfamily: res.subfamily };
    } catch (e) {
      return { ok: false, family: wanted, source: 'decode-error', error: String(e) };
    }
  }

  /**
   * True when the platform resolves this family itself.
   *
   * document.fonts.check() only knows about faces the document loaded, so it
   * says no to every installed-but-unloaded system font. Measuring instead is
   * the reliable test: text set in an unknown family falls back and matches the
   * generic base exactly, while a family the system knows renders differently.
   */
  static rendersLocally(family) {
    const name = String(family || '').replace(/["\\]/g, '').trim();
    if (!name) return false;
    if (!FontLoader._probeCtx) {
      const canvas = document.createElement('canvas');
      FontLoader._probeCtx = canvas.getContext('2d');
    }
    const ctx = FontLoader._probeCtx;
    if (!ctx) return false;
    const sample = 'mmmmmmmmmmlliWQ@#08';
    // Three bases, because a face can happen to match one of them in width.
    return ['monospace', 'serif', 'sans-serif'].some((base) => {
      ctx.font = `72px ${base}`;
      const control = ctx.measureText(sample).width;
      ctx.font = `72px "${name}", ${base}`;
      return Math.abs(ctx.measureText(sample).width - control) > 0.5;
    });
  }

  /**
   * True when the page itself has registered a face under this family.
   *
   * Deliberately not document.fonts.check(): that answers "would this font
   * list render?", which is true even for a name nothing can draw, because the
   * fallback at the end of the list is always available. Trusting it meant an
   * uninstalled brand font was reported as loaded and the operator was never
   * told the preview did not match Premiere.
   */
  _documentDeclares(family) {
    const wanted = String(family || '').toLowerCase();
    try {
      let found = false;
      document.fonts.forEach((face) => {
        if (!found && String(face.family).replace(/["']/g, '').toLowerCase() === wanted &&
            face.status === 'loaded') {
          found = true;
        }
      });
      return found;
    } catch (e) {
      return false;
    }
  }

  static base64ToBytes(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
}

window.FontLoader = FontLoader;
