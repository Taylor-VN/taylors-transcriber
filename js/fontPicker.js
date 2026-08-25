/**
 * Typography font picker.
 *
 * The typography box used to be a bare <input> with a <datalist>. WKWebView
 * gives a datalist no visible affordance, so the installed fonts the backend
 * enumerates were effectively invisible — you had to already know the name and
 * type it. This turns the same box into a dropdown: click it and every
 * installed family is listed, each drawn in its own face.
 *
 * It stays a combobox rather than a <select>, because an imported Premiere
 * style names a face this list cannot enumerate ("Specsavers-Regular") and a
 * <select> would silently drop it. Typed text is always kept; a value that is
 * not an installed family is pinned at the top of the list and marked, so a
 * missing brand font reads as missing instead of looking like a typo.
 */

const FONT_ROW_H = 24;      // keep in sync with .font-picker-row height
const FONT_OVERSCAN = 4;    // rows rendered beyond the viewport, each side

class FontPicker {
  constructor(input, options = {}) {
    this.input = input;
    this.onSelect = options.onSelect || (() => {});
    // Asked again when the list is still empty on open: the backend may not
    // have been reachable when the page first asked for it.
    this.loadFamilies = options.loadFamilies || null;
    this.loading = false;
    this.families = [];
    this.matches = [];
    this.rows = [];          // pooled row elements, reused while scrolling
    this.active = -1;        // index into this.matches
    this.open = false;
    this.committing = false;
    this.committed = input.value;

    this._build();
    this._wire();
  }

  /** Replaces the offered families; safe to call after the list arrives. */
  setFamilies(families) {
    this.families = Array.isArray(families) ? families.slice() : [];
    if (this.open) this._filter(this.query);
  }

  // --- construction -----------------------------------------------------

  _build() {
    const wrap = document.createElement('div');
    wrap.className = 'font-picker';
    this.input.parentNode.insertBefore(wrap, this.input);
    wrap.appendChild(this.input);
    this.input.classList.add('font-picker-input');
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');

    this.caret = document.createElement('button');
    this.caret.type = 'button';
    this.caret.className = 'font-picker-caret';
    this.caret.tabIndex = -1;
    this.caret.setAttribute('aria-label', 'Show installed fonts');
    this.caret.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    wrap.appendChild(this.caret);

    // The panel lives on <body>, positioned to the box on open: the inspector
    // scrolls, and an in-flow panel would be clipped by it after ~two rows.
    this.panel = document.createElement('div');
    this.panel.className = 'font-picker-panel';
    this.panel.hidden = true;

    this.list = document.createElement('div');
    this.list.className = 'font-picker-list';
    this.list.setAttribute('role', 'listbox');
    this.spacer = document.createElement('div');
    this.spacer.className = 'font-picker-spacer';
    this.list.appendChild(this.spacer);

    this.empty = document.createElement('div');
    this.empty.className = 'font-picker-empty';
    this.empty.hidden = true;

    this.panel.appendChild(this.list);
    this.panel.appendChild(this.empty);
    document.body.appendChild(this.panel);
    this.wrap = wrap;
  }

  _wire() {
    this._reposition = () => { if (this.open) this._position(); };

    // WebKit does not blur a focused input when you click a non-focusable
    // element, so blur alone leaves the list on screen after a click elsewhere
    // in the inspector. Watching the document is what actually closes it.
    this._onOutsideDown = (e) => {
      if (!this.open) return;
      if (this.wrap.contains(e.target) || this.panel.contains(e.target)) return;
      this._close();
    };

    this.caret.addEventListener('mousedown', (e) => {
      // mousedown, not click: the input must not blur the panel shut first.
      e.preventDefault();
      if (this.open) this._close();
      else { this.input.focus(); this._open(''); }
    });

    // Opening on mousedown rather than focus: the box keeps focus after a
    // selection, and focus fires again every time the window is reactivated —
    // which would pop the list open on returning to the app. Down-arrow opens
    // it for anyone who reached the box with the keyboard.
    this.input.addEventListener('mousedown', () => { if (!this.open) this._open(''); });
    this.input.addEventListener('input', () => {
      // Ignore the synthetic event a commit fires, which would reopen the list
      // immediately after a selection closed it.
      if (this.committing) return;
      // Typing narrows the list; the value itself stays whatever was typed, so
      // a hand-entered face that is not installed still reaches the preview.
      this._open(this.input.value);
    });
    this.input.addEventListener('keydown', (e) => this._onKey(e));
    this.input.addEventListener('blur', () => this._close());

    this.list.addEventListener('scroll', () => this._render());
    this.list.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.font-picker-row');
      if (!row) return;
      e.preventDefault();   // hold focus so blur does not close before commit
      this._commit(Number(row.dataset.index));
    });
    this.list.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.font-picker-row');
      if (row) this._setActive(Number(row.dataset.index), false);
    });
  }

  // --- open / close -----------------------------------------------------

  _open(query) {
    const wasOpen = this.open;
    this.open = true;
    this.wrap.classList.add('open');
    this.input.setAttribute('aria-expanded', 'true');
    this.panel.hidden = false;
    if (!wasOpen) {
      // Any ancestor scroll moves the box out from under a fixed panel.
      window.addEventListener('scroll', this._reposition, true);
      window.addEventListener('resize', this._reposition);
      document.addEventListener('mousedown', this._onOutsideDown, true);
    }
    this._position();
    this._filter(query);
    if (!wasOpen) this._scrollToActive();
    if (!this.families.length) this._retryFamilies();
  }

  _retryFamilies() {
    if (this.loading || !this.loadFamilies) return;
    this.loading = true;
    this.empty.textContent = 'Looking for installed fonts…';
    Promise.resolve(this.loadFamilies())
      .then((families) => {
        this.loading = false;
        this.setFamilies(families);
        if (this.open) this._filter(this.query);
      })
      .catch(() => { this.loading = false; if (this.open) this._filter(this.query); });
  }

  _close() {
    if (!this.open) return;
    this.open = false;
    this.wrap.classList.remove('open');
    this.input.setAttribute('aria-expanded', 'false');
    this.panel.hidden = true;
    this.active = -1;
    window.removeEventListener('scroll', this._reposition, true);
    window.removeEventListener('resize', this._reposition);
    document.removeEventListener('mousedown', this._onOutsideDown, true);
  }

  /** Anchors the panel under the box, flipping above it when space is short. */
  _position() {
    const box = this.wrap.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - 8;
    const above = box.top - 8;
    const flip = below < 140 && above > below;
    const height = Math.max(80, Math.min(FONT_ROW_H * 11, flip ? above : below));

    // The typography box is narrow; give the list room for real font names
    // rather than ellipsising most of them, while staying on screen.
    const width = Math.min(Math.max(box.width, 240), window.innerWidth - 16);
    const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
    this.panel.style.left = `${Math.round(left)}px`;
    this.panel.style.width = `${Math.round(width)}px`;
    this.panel.style.maxHeight = `${Math.round(height)}px`;
    if (flip) {
      this.panel.style.top = 'auto';
      this.panel.style.bottom = `${Math.round(window.innerHeight - box.top + 3)}px`;
    } else {
      this.panel.style.bottom = 'auto';
      this.panel.style.top = `${Math.round(box.bottom + 3)}px`;
    }
  }

  // --- matching ---------------------------------------------------------

  _filter(query) {
    this.query = query || '';
    const needle = this.query.trim().toLowerCase();
    const current = this.input.value.trim();

    let names = this.families;
    if (needle) {
      // Prefix matches first — typing "hel" should reach Helvetica before
      // anything that merely contains those letters.
      const starts = [];
      const contains = [];
      for (const name of names) {
        const lower = name.toLowerCase();
        if (lower.startsWith(needle)) starts.push(name);
        else if (lower.includes(needle)) contains.push(name);
      }
      names = starts.concat(contains);
    }

    this.matches = names.map((name) => ({ name, missing: false }));

    // A face named by an imported preset but absent from this machine is still
    // the current value: show it rather than pretending the box is empty. Only
    // when the list was opened, never mid-typing — half-typed text is not a
    // font, and pinning it would put it under Enter instead of the top match.
    if (!needle && current &&
        !this.families.some((f) => f.toLowerCase() === current.toLowerCase())) {
      this.matches.unshift({ name: current, missing: true });
    }

    this.empty.hidden = this.matches.length > 0;
    if (this.families.length) {
      this.empty.textContent = 'No installed font matches.';
    } else if (this.loading) {
      this.empty.textContent = 'Looking for installed fonts…';
    } else {
      this.empty.textContent = 'Could not read the installed fonts.';
    }

    // Keep the highlight on the current value when it is in view.
    const idx = this.matches.findIndex((m) => m.name.toLowerCase() === current.toLowerCase());
    this.active = idx >= 0 ? idx : (this.matches.length ? 0 : -1);
    this.list.scrollTop = 0;
    this._render();
  }

  // --- virtualised rendering -------------------------------------------

  _render() {
    const total = this.matches.length;
    this.spacer.style.height = `${total * FONT_ROW_H}px`;

    const viewport = this.list.clientHeight || FONT_ROW_H * 10;
    const first = Math.max(0, Math.floor(this.list.scrollTop / FONT_ROW_H) - FONT_OVERSCAN);
    const last = Math.min(total, Math.ceil((this.list.scrollTop + viewport) / FONT_ROW_H) + FONT_OVERSCAN);

    let pooled = 0;
    for (let i = first; i < last; i++) {
      const row = this._row(pooled++);
      const match = this.matches[i];
      row.dataset.index = String(i);
      row.style.transform = `translateY(${i * FONT_ROW_H}px)`;
      row.textContent = match.name;
      // Draw each name in its own face — the fastest way to recognise a font.
      row.style.fontFamily = `"${match.name.replace(/"/g, '')}", var(--font)`;
      row.classList.toggle('missing', match.missing);
      row.title = match.missing ? `${match.name} — not installed on this machine` : match.name;
      row.classList.toggle('active', i === this.active);
      row.setAttribute('aria-selected', i === this.active ? 'true' : 'false');
      row.hidden = false;
    }
    for (let i = pooled; i < this.rows.length; i++) this.rows[i].hidden = true;
  }

  _row(poolIndex) {
    let row = this.rows[poolIndex];
    if (!row) {
      row = document.createElement('div');
      row.className = 'font-picker-row';
      row.setAttribute('role', 'option');
      this.list.appendChild(row);
      this.rows[poolIndex] = row;
    }
    return row;
  }

  // --- selection --------------------------------------------------------

  _setActive(index, scroll = true) {
    if (index < 0 || index >= this.matches.length || index === this.active) return;
    this.active = index;
    this._render();
    if (scroll) this._scrollToActive();
  }

  _scrollToActive() {
    if (this.active < 0) return;
    const top = this.active * FONT_ROW_H;
    const viewport = this.list.clientHeight || FONT_ROW_H * 10;
    if (top < this.list.scrollTop) this.list.scrollTop = top;
    else if (top + FONT_ROW_H > this.list.scrollTop + viewport) {
      this.list.scrollTop = top + FONT_ROW_H - viewport;
    }
    this._render();
  }

  _commit(index) {
    const match = this.matches[index];
    if (!match) return;
    this.input.value = match.name;
    this.committed = match.name;
    this._close();
    // Fire the same events a typed edit fires, so the inspector wiring that
    // rebuilds the preset needs to know nothing about this control.
    this.committing = true;
    try {
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
      this.input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      this.committing = false;
    }
    this.onSelect(match.name, match);
  }

  _onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.open) { this._open(''); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(this.matches.length - 1, Math.max(0, this.active + step));
      this._setActive(next);
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      if (!this.open) return;
      e.preventDefault();
      const page = Math.max(1, Math.floor((this.list.clientHeight || 240) / FONT_ROW_H) - 1);
      const step = e.key === 'PageDown' ? page : -page;
      this._setActive(Math.min(this.matches.length - 1, Math.max(0, this.active + step)));
      return;
    }
    if (e.key === 'Enter') {
      if (!this.open || this.active < 0) return;
      e.preventDefault();
      this._commit(this.active);
      return;
    }
    if (e.key === 'Escape') {
      if (!this.open) return;
      e.preventDefault();
      e.stopPropagation();
      this._close();
    }
  }
}

window.FontPicker = FontPicker;
