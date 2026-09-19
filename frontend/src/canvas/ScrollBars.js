import { SpatialIndex } from "./spatial.js";

// ─────────────────────────────────────────────
//  SCROLLBARS
//
//  The canvas is an infinite pan/zoom surface,
//  not a scrolling document, so there is no
//  native scrollbar to inherit. These are drawn
//  and driven here, and each axis is dragged
//  independently.
//
//  The scrollable extent is the content itself
//  plus a screenful of slack on every side, so
//  there is always somewhere to go rather than
//  hitting a hard wall at the last stroke.
// ─────────────────────────────────────────────
const THICKNESS = 12;

export class ScrollBars {
  constructor(app) {
    this.app = app;
    this.scene = app.scene;
    this.store = app.store;

    this.vertical = this._build("vertical");
    this.horizontal = this._build("horizontal");
    app.host.append(this.vertical.track, this.horizontal.track);

    app.host.addEventListener("scene:transform", () => this.update());
    app.host.addEventListener("scene:changed", () => this.update());
    app.host.addEventListener("scene:reload", () => this.update());
    window.addEventListener("resize", () => this.update());

    this.update();
  }

  _build(axis) {
    const track = document.createElement("div");
    track.className = `ntbk-scrollbar ntbk-scrollbar-${axis}`;

    const thumb = document.createElement("div");
    thumb.className = "ntbk-scrollthumb";
    track.appendChild(thumb);

    thumb.addEventListener("pointerdown", (event) =>
      this._startDrag(event, axis, track));

    // Clicking the empty track jumps to roughly that position
    track.addEventListener("pointerdown", (event) => {
      if (event.target === thumb) return;
      event.stopPropagation();
      const rect = track.getBoundingClientRect();
      const fraction = axis === "vertical"
        ? (event.clientY - rect.top) / rect.height
        : (event.clientX - rect.left) / rect.width;
      this._scrollToFraction(axis, fraction, true);
    });

    return { track, thumb };
  }

  /** Everything worth scrolling to, in scene coordinates. */
  _contentBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const merge = (a, b, c, d) => {
      minX = Math.min(minX, a); minY = Math.min(minY, b);
      maxX = Math.max(maxX, c); maxY = Math.max(maxY, d);
    };

    for (const page of this.store.data.canvas.pages) {
      merge(page.x, page.y, page.x + page.w, page.y + page.h);
    }
    for (const stroke of this.store.strokes) {
      const box = SpatialIndex.bboxOf(stroke);
      merge(box.minX, box.minY, box.maxX, box.maxY);
    }
    for (const object of this.store.objects) {
      merge(object.x, object.y, object.x + object.w, object.y + object.h);
    }
    if (!Number.isFinite(minX)) merge(0, 0, 1, 1);
    return { minX, minY, maxX, maxY };
  }

  /** Scene-space view rectangle and the extent it scrolls within. */
  _metrics() {
    const scale = this.scene.scale;
    const hostRect = this.app.host.getBoundingClientRect();
    const sceneRect = this.scene.sceneEl.getBoundingClientRect();

    const viewW = hostRect.width / scale;
    const viewH = hostRect.height / scale;
    const viewX = (hostRect.left - sceneRect.left) / scale;
    const viewY = (hostRect.top - sceneRect.top) / scale;

    const content = this._contentBounds();
    // A screenful of slack each side, and the extent always covers the
    // current view so the thumb can't be pushed outside its own track
    const extent = {
      minX: Math.min(content.minX - viewW, viewX),
      minY: Math.min(content.minY - viewH, viewY),
      maxX: Math.max(content.maxX + viewW, viewX + viewW),
      maxY: Math.max(content.maxY + viewH, viewY + viewH),
    };

    return { scale, viewX, viewY, viewW, viewH, extent };
  }

  update() {
    const { viewX, viewY, viewW, viewH, extent } = this._metrics();

    const spanX = extent.maxX - extent.minX;
    const spanY = extent.maxY - extent.minY;

    const hSize = Math.max(8, (viewW / spanX) * 100);
    const hPos = ((viewX - extent.minX) / spanX) * 100;
    this.horizontal.thumb.style.width = `${Math.min(100, hSize)}%`;
    this.horizontal.thumb.style.left = `${Math.max(0, Math.min(100 - hSize, hPos))}%`;

    const vSize = Math.max(8, (viewH / spanY) * 100);
    const vPos = ((viewY - extent.minY) / spanY) * 100;
    this.vertical.thumb.style.height = `${Math.min(100, vSize)}%`;
    this.vertical.thumb.style.top = `${Math.max(0, Math.min(100 - vSize, vPos))}%`;
  }

  _startDrag(event, axis, track) {
    event.preventDefault();
    event.stopPropagation();   // the canvas must not see this as a click

    const trackRect = track.getBoundingClientRect();
    const trackLength = axis === "vertical" ? trackRect.height : trackRect.width;
    const { extent } = this._metrics();
    const span = axis === "vertical"
      ? extent.maxY - extent.minY
      : extent.maxX - extent.minX;

    // Tracked incrementally rather than from the press point, so a slow drag
    // can't accumulate rounding error over its length
    let last = axis === "vertical" ? event.clientY : event.clientX;

    const move = (moveEvent) => {
      const now = axis === "vertical" ? moveEvent.clientY : moveEvent.clientX;
      const deltaScene = ((now - last) / trackLength) * span;
      last = now;

      // Panning is the inverse of scrolling: dragging the thumb down moves
      // the view down, which means shifting the scene up
      const scale = this.scene.scale;
      this.scene.panBy(
        axis === "vertical" ? 0 : -deltaScene * scale,
        axis === "vertical" ? -deltaScene * scale : 0,
      );
      this.app.selectionController?.refresh();
      this.update();   // thumb follows the view, not the finger
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _scrollToFraction(axis, fraction, animate) {
    const { extent, viewX, viewY, viewW, viewH, scale } = this._metrics();
    if (axis === "vertical") {
      const span = extent.maxY - extent.minY;
      const targetY = extent.minY + fraction * span - viewH / 2;
      this.scene.panBy(0, -(targetY - viewY) * scale);
    } else {
      const span = extent.maxX - extent.minX;
      const targetX = extent.minX + fraction * span - viewW / 2;
      this.scene.panBy(-(targetX - viewX) * scale, 0);
    }
    this.app.selectionController?.refresh();
    this.update();
  }
}

export const SCROLLBAR_THICKNESS = THICKNESS;
