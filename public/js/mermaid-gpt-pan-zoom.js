/**
 * PanZoom — GPU-accelerated, cursor-anchored pan/zoom for high-resolution diagrams.
 *
 * Key design decisions:
 * - All transform writes are batched through requestAnimationFrame to avoid
 *   mid-frame layout thrashing and ensure compositing happens on the GPU thread.
 * - Zoom always anchors to the cursor position so the point under the pointer
 *   stays fixed — this is what makes zooming feel fluid and natural.
 * - MAX_SCALE is set high (30x) to support 100+ megapixel PNG outputs.
 * - will-change: transform is set on the target element so the browser promotes
 *   it to its own GPU compositing layer immediately.
 * - Pinch-to-zoom is supported via Touch events for trackpad gesture pass-through.
 */
window.PanZoom = class PanZoom {
  constructor(viewport, target) {
    this.viewport = viewport;
    this.target = target;
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.dragging = false;
    this.startX = 0;
    this.startY = 0;
    this.MIN_SCALE = 0.05;
    this.MAX_SCALE = 30;

    // RAF state
    this._rafId = null;
    this._dirty = false;

    // Touch/pinch state
    this._lastPinchDist = null;
    this._lastTouchMid = null;

    // Promote target to GPU compositing layer immediately
    this.target.style.willChange = 'transform';
    this.target.style.transformOrigin = '0 0';

    // Bind
    this._onWheel = this._onWheel.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._rafFlush = this._rafFlush.bind(this);

    viewport.addEventListener('wheel', this._onWheel, { passive: false });
    viewport.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    viewport.addEventListener('keydown', this._onKeyDown);
    viewport.addEventListener('touchstart', this._onTouchStart, { passive: false });
    viewport.addEventListener('touchmove', this._onTouchMove, { passive: false });
    viewport.addEventListener('touchend', this._onTouchEnd);
    viewport.setAttribute('tabindex', '0');

    this._apply();
  }

  // ---- RAF-batched transform write ----------------------------------------

  _scheduleFlush() {
    if (!this._dirty) {
      this._dirty = true;
      this._rafId = requestAnimationFrame(this._rafFlush);
    }
  }

  _rafFlush() {
    this._dirty = false;
    this._rafId = null;
    // Use translate3d to force GPU layer; scale3d keeps the pipeline on compositor
    this.target.style.transform =
      `translate3d(${this.x}px, ${this.y}px, 0) scale3d(${this.scale}, ${this.scale}, 1)`;
  }

  _apply() {
    this._scheduleFlush();
  }

  // ---- Zoom anchored to a viewport point ----------------------------------

  /**
   * Zoom by `factor` keeping the viewport point (px, py) stationary.
   * @param {number} factor  Multiplier (e.g. 1.1 to zoom in, 0.9 to zoom out)
   * @param {number} px      X coordinate in viewport space
   * @param {number} py      Y coordinate in viewport space
   */
  _zoomAt(factor, px, py) {
    const newScale = Math.min(this.MAX_SCALE, Math.max(this.MIN_SCALE, this.scale * factor));
    if (newScale === this.scale) return;

    // Point in content space before scale change
    const contentX = (px - this.x) / this.scale;
    const contentY = (py - this.y) / this.scale;

    // After scale change, pan so contentX/contentY maps back to (px, py)
    this.x = px - contentX * newScale;
    this.y = py - contentY * newScale;
    this.scale = newScale;

    this._apply();
  }

  // ---- Mouse wheel --------------------------------------------------------

  _onWheel(e) {
    e.preventDefault();
    e.stopPropagation();

    const rect = this.viewport.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Smooth scroll: trackpads send small deltaY values, mice send larger ones.
    // Normalise to a consistent per-event factor.
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 20;  // line mode → pixel
    if (e.deltaMode === 2) delta *= 200; // page mode → pixel

    // Clamp to prevent a single large event from jumping too far
    const clamped = Math.max(-80, Math.min(80, delta));
    const factor = Math.pow(0.999, clamped);

    this._zoomAt(factor, px, py);
  }

  // ---- Mouse drag ---------------------------------------------------------

  _onMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragging = true;
    this.startX = e.clientX - this.x;
    this.startY = e.clientY - this.y;
    this.viewport.style.cursor = 'grabbing';
  }

  _onMouseMove(e) {
    if (!this.dragging) return;
    this.x = e.clientX - this.startX;
    this.y = e.clientY - this.startY;
    this._apply();
  }

  _onMouseUp() {
    this.dragging = false;
    this.viewport.style.cursor = 'grab';
  }

  // ---- Touch / pinch ------------------------------------------------------

  _pinchDist(t) {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _pinchMid(t, rect) {
    return {
      x: (t[0].clientX + t[1].clientX) / 2 - rect.left,
      y: (t[0].clientY + t[1].clientY) / 2 - rect.top,
    };
  }

  _onTouchStart(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      this._lastPinchDist = this._pinchDist(e.touches);
      const rect = this.viewport.getBoundingClientRect();
      this._lastTouchMid = this._pinchMid(e.touches, rect);
    } else if (e.touches.length === 1) {
      this.dragging = true;
      this.startX = e.touches[0].clientX - this.x;
      this.startY = e.touches[0].clientY - this.y;
    }
  }

  _onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 2 && this._lastPinchDist !== null) {
      const dist = this._pinchDist(e.touches);
      const factor = dist / this._lastPinchDist;
      const rect = this.viewport.getBoundingClientRect();
      const mid = this._pinchMid(e.touches, rect);
      this._zoomAt(factor, mid.x, mid.y);
      this._lastPinchDist = dist;
      this._lastTouchMid = mid;
    } else if (e.touches.length === 1 && this.dragging) {
      this.x = e.touches[0].clientX - this.startX;
      this.y = e.touches[0].clientY - this.startY;
      this._apply();
    }
  }

  _onTouchEnd() {
    this.dragging = false;
    this._lastPinchDist = null;
    this._lastTouchMid = null;
  }

  // ---- Keyboard -----------------------------------------------------------

  _onKeyDown(e) {
    const STEP = 40;
    const rect = this.viewport.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    switch (e.key) {
      case 'ArrowUp':     e.preventDefault(); this.y += STEP; this._apply(); break;
      case 'ArrowDown':   e.preventDefault(); this.y -= STEP; this._apply(); break;
      case 'ArrowLeft':   e.preventDefault(); this.x += STEP; this._apply(); break;
      case 'ArrowRight':  e.preventDefault(); this.x -= STEP; this._apply(); break;
      case '+': case '=': e.preventDefault(); this._zoomAt(1.15, cx, cy); break;
      case '-':           e.preventDefault(); this._zoomAt(1 / 1.15, cx, cy); break;
      case '0':           e.preventDefault(); this.reset(); break;
      default: return;
    }
  }

  // ---- Public API ---------------------------------------------------------

  reset() {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this._apply();
  }

  /**
   * Fit the content into the viewport at its natural size.
   * Useful for large diagrams that would overflow at scale=1.
   */
  fitToViewport() {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const tw = this.target.naturalWidth || this.target.clientWidth || 800;
    const th = this.target.naturalHeight || this.target.clientHeight || 600;
    const scaleX = vw / tw;
    const scaleY = vh / th;
    this.scale = Math.min(1, scaleX, scaleY);
    this.x = (vw - tw * this.scale) / 2;
    this.y = (vh - th * this.scale) / 2;
    this._apply();
  }

  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.viewport.removeEventListener('wheel', this._onWheel);
    this.viewport.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    this.viewport.removeEventListener('keydown', this._onKeyDown);
    this.viewport.removeEventListener('touchstart', this._onTouchStart);
    this.viewport.removeEventListener('touchmove', this._onTouchMove);
    this.viewport.removeEventListener('touchend', this._onTouchEnd);
  }
};
