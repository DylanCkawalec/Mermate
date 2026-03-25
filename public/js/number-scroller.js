/**
 * NumberScroller — Animated rolling-number display.
 *
 * Ease-in-out curve: numbers start slow, spin fast, wind down slow.
 * Like starting and stopping a race — the odometer effect.
 */
window.NumberScroller = class NumberScroller {
  constructor() {
    this._active = new Map();
  }

  /**
   * Animate a DOM element's text from one value to another.
   * @param {HTMLElement} el      Target element (textContent is updated each frame)
   * @param {number}      from    Starting numeric value
   * @param {number}      to      Ending numeric value
   * @param {string}      format  'int' | 'float' | 'currency' | 'time' | 'pct'
   * @param {number}      [durationMs] Override duration (auto-scales otherwise)
   * @returns {Promise<void>}
   */
  animate(el, from, to, format = 'int', durationMs) {
    const prev = this._active.get(el);
    if (prev) cancelAnimationFrame(prev);

    if (from === to) {
      el.textContent = this._format(to, format);
      return Promise.resolve();
    }

    const delta = Math.abs(to - from);
    const duration = durationMs || this._autoDuration(delta, format);

    return new Promise(resolve => {
      const start = performance.now();

      const tick = (now) => {
        const elapsed = now - start;
        const t = Math.min(elapsed / duration, 1);
        const eased = this._easeInOut(t);
        const current = from + (to - from) * eased;

        el.textContent = this._format(current, format);

        if (t < 1) {
          this._active.set(el, requestAnimationFrame(tick));
        } else {
          el.textContent = this._format(to, format);
          this._active.delete(el);
          resolve();
        }
      };

      this._active.set(el, requestAnimationFrame(tick));
    });
  }

  /** Cubic ease-in-out: slow start, fast middle, slow stop. */
  _easeInOut(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /** Scale duration with magnitude so small changes are quick, large ones dramatic. */
  _autoDuration(delta, format) {
    if (format === 'currency') return Math.min(400 + delta * 800, 1200);
    if (format === 'float' || format === 'pct') return Math.min(400 + delta * 600, 1000);
    if (format === 'time') return Math.min(400 + delta * 40, 1000);
    const log = delta > 0 ? Math.log10(delta + 1) : 0;
    return Math.min(400 + log * 280, 1200);
  }

  _format(value, format) {
    switch (format) {
      case 'float': return value.toFixed(2);
      case 'currency': return '$' + value.toFixed(2);
      case 'time': return value.toFixed(1) + 's';
      case 'pct': return Math.round(value) + '%';
      case 'int':
      default:
        return Math.round(value).toLocaleString();
    }
  }

  dispose() {
    for (const id of this._active.values()) cancelAnimationFrame(id);
    this._active.clear();
  }
};
