/**
 * Scrubbable number fields — Premiere's draggable values.
 *
 * In Premiere every number in the Essential Graphics panel is a scrubber: drag
 * sideways to change it, click to type into it. This wraps a plain
 * <input type="number"> so it behaves the same way, and leaves the input a real
 * input — typing, arrow keys, form value and the `input` event the rest of the
 * app already listens for all keep working.
 *
 * A drag only starts after the pointer has actually moved, so a click still
 * lands in the field for typing. Premiere's modifiers are honoured: Shift
 * coarsens by ten, Alt/Option refines by a tenth.
 */

const SCRUB_THRESHOLD_PX = 3;

class Scrubbable {
  /**
   * @param {HTMLInputElement} input  the number input to make draggable
   * @param {object} [opts]
   * @param {number} [opts.step]      units per pixel dragged (default 1)
   * @param {number} [opts.precision] decimal places to round to (default 0)
   */
  static attach(input, opts = {}) {
    if (!input || input.dataset.scrubbable === 'on') return;
    input.dataset.scrubbable = 'on';
    input.classList.add('scrubbable');

    const step = opts.step > 0 ? opts.step : 1;
    const precision = opts.precision || 0;
    const min = input.min === '' ? -Infinity : parseFloat(input.min);
    const max = input.max === '' ? Infinity : parseFloat(input.max);

    let startX = 0;
    let startValue = 0;
    let dragging = false;
    let pointerId = null;
    // Set when a drag ends, so the click that closes it can be swallowed. Held
    // as a flag rather than a one-shot listener because a pointer released off
    // the field produces no click at all, and a listener left armed would then
    // eat the next genuine click-to-type.
    let suppressClick = false;

    const round = (n) => {
      const f = Math.pow(10, precision);
      return Math.round(n * f) / f;
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      startX = e.clientX;
      startValue = parseFloat(input.value) || 0;
      dragging = false;
      suppressClick = false;
      pointerId = e.pointerId;
      // Captured from the first press rather than once the drag is recognised:
      // a quick flick can carry the pointer off a 58px-wide field between two
      // move events, and without capture those events land on whatever is
      // underneath instead. Capture does not stop the field being focused, so
      // click-to-type still works.
      try { input.setPointerCapture(pointerId); } catch (err) { /* synthetic or stale pointer */ }
      input.addEventListener('pointermove', onPointerMove);
      input.addEventListener('pointerup', onPointerUp);
      input.addEventListener('pointercancel', onPointerUp);
    };

    const onPointerMove = (e) => {
      const dx = e.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < SCRUB_THRESHOLD_PX) return;
        dragging = true;
        // Taking the caret out first stops the drag from selecting the text
        // under it, which is what a click-drag inside a text field normally does.
        input.blur();
        document.body.classList.add('scrubbing');
      }
      e.preventDefault();

      const scale = e.shiftKey ? 10 : (e.altKey ? 0.1 : 1);
      const next = Math.min(max, Math.max(min, round(startValue + dx * step * scale)));
      if (String(next) === input.value) return;
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const onPointerUp = () => {
      input.removeEventListener('pointermove', onPointerMove);
      input.removeEventListener('pointerup', onPointerUp);
      input.removeEventListener('pointercancel', onPointerUp);
      try {
        if (pointerId !== null && input.hasPointerCapture(pointerId)) input.releasePointerCapture(pointerId);
      } catch (err) { /* already released with the pointer */ }
      if (dragging) {
        document.body.classList.remove('scrubbing');
        // Letting go of a scrubber should not drop a caret in the field.
        suppressClick = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      dragging = false;
      pointerId = null;
    };

    input.addEventListener('pointerdown', onPointerDown);
    input.addEventListener('click', (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /** Attaches to every element matching `selector`. */
  static attachAll(selector, opts) {
    document.querySelectorAll(selector).forEach(el => Scrubbable.attach(el, opts));
  }
}

if (typeof window !== 'undefined') window.Scrubbable = Scrubbable;
if (typeof module !== 'undefined' && module.exports) module.exports = { Scrubbable };
