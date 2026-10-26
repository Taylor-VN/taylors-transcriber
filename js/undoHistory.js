/**
 * Undo / redo.
 *
 * Snapshot-based rather than a log of operations. Captions change through a
 * dozen routes — typing, the timeline's drag handles, split, merge, ripple,
 * shift, transcription, imports, find and replace — and an operation log would
 * need every one of them to describe its own inverse. A snapshot of what the
 * edit touched is one function, and it cannot miss a route that is added later.
 *
 * Recording is debounced: a burst of changes (a word typed, a slider dragged
 * through forty values) settles into one step, which is also what the
 * operator thinks of as "one change".
 *
 * Only content compares — captions and styles. Where the operator happens to be
 * standing is stored with each snapshot so an undo can take them back to where
 * the change was made, but moving between films or ratios is not itself a step.
 */

class UndoHistory {
  /**
   * @param {Object} opts
   *   capture  () => { content, location } — content must be JSON-serialisable
   *   restore  (content, location) => void
   *   limit    steps kept in each direction
   *   settleMs quiet time that ends a burst of changes
   */
  constructor(opts) {
    this.capture = opts.capture;
    this.restoreFn = opts.restore;
    this.limit = opts.limit || 200;
    this.settleMs = opts.settleMs !== undefined ? opts.settleMs : 500;
    this.undoStack = [];
    this.redoStack = [];
    this.current = null;
    this.timer = null;
    this.restoring = false;
    this.listeners = [];
  }

  onChange(cb) {
    this.listeners.push(cb);
  }

  notify() {
    this.listeners.forEach(cb => cb(this.canUndo(), this.canRedo()));
  }

  snapshot() {
    const snap = this.capture();
    return { json: JSON.stringify(snap.content), location: snap.location };
  }

  /** Forgets everything — a different project is not something to undo into. */
  reset() {
    clearTimeout(this.timer);
    this.timer = null;
    this.undoStack = [];
    this.redoStack = [];
    this.current = this.snapshot();
    this.notify();
  }

  /** Something changed; fold it into a step once the burst settles. */
  schedule() {
    if (this.restoring) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.commit(), this.settleMs);
  }

  /** Records the pending change now, if there is one. */
  commit() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.restoring) return;
    if (!this.current) { this.current = this.snapshot(); return; }

    const next = this.snapshot();
    // Moving between films or ratios is not a change. The snapshot keeps the
    // location it was taken at — where the edit was made — so undo goes there.
    if (next.json === this.current.json) return;
    this.undoStack.push(this.current);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.current = next;
    this.notify();
  }

  canUndo() {
    return this.undoStack.length > 0 || this.timer !== null;
  }

  canRedo() {
    return this.redoStack.length > 0 && this.timer === null;
  }

  undo() {
    // A change still settling is the most recent one, so it is what goes first.
    if (this.timer !== null) this.commit();
    if (!this.undoStack.length) return false;

    const undone = this.current;
    const target = this.undoStack.pop();
    this.redoStack.push(undone);
    this.current = target;
    // Undo where the change was made, not where the operator wandered to since.
    this.apply(target.json, undone.location);
    return true;
  }

  redo() {
    if (this.timer !== null) this.commit();
    if (!this.redoStack.length) return false;

    const target = this.redoStack.pop();
    this.undoStack.push(this.current);
    this.current = target;
    this.apply(target.json, target.location);
    return true;
  }

  apply(json, location) {
    this.restoring = true;
    try {
      this.restoreFn(JSON.parse(json), location);
    } finally {
      this.restoring = false;
      // Listeners fired by the restore must not record it as a fresh change.
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.notify();
  }
}

window.UndoHistory = UndoHistory;
