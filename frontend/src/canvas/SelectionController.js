import { patchElements } from "../model/history.js";
import { SpatialIndex } from "./spatial.js";

// ─────────────────────────────────────────────
//  SELECTION + TRANSFORM
//
//  Handles are rendered and driven here rather
//  than by Moveable. Moveable could not measure
//  a target living inside the pan/zoom
//  transformed scene — it produced a 0x0 drag
//  surface and swallowed handle pointerdowns
//  without ever starting a gesture.
//
//  The overlay lives in the viewport, OUTSIDE
//  the scene transform, so handles stay the
//  same size on screen at any zoom.
//
//  Gestures are measured in scene coordinates
//  from client positions, so the transform can
//  never skew the maths.
// ─────────────────────────────────────────────

//  Index order matches the Qt prototype:
//    0 1 2
//    7   3
//    6 5 4
const DIRECTIONS = [
  { x: -1, y: -1, cursor: "nwse-resize" },
  { x:  0, y: -1, cursor: "ns-resize" },
  { x:  1, y: -1, cursor: "nesw-resize" },
  { x:  1, y:  0, cursor: "ew-resize" },
  { x:  1, y:  1, cursor: "nwse-resize" },
  { x:  0, y:  1, cursor: "ns-resize" },
  { x: -1, y:  1, cursor: "nesw-resize" },
  { x: -1, y:  0, cursor: "ew-resize" },
];

export class SelectionController {
  constructor(app) {
    this.app = app;
    this.scene = app.scene;
    this.snapshot = null;
    this.moving = false;
    this.resizing = false;
    this.direction = null;

    this.overlay = document.createElement("div");
    this.overlay.className = "ntbk-handles";
    this.overlay.hidden = true;

    this.box = document.createElement("div");
    this.box.className = "ntbk-selbox";
    this.overlay.appendChild(this.box);

    this.handles = DIRECTIONS.map((dir) => {
      const el = document.createElement("div");
      el.className = "ntbk-handle";
      el.style.cursor = dir.cursor;
      el.addEventListener("pointerdown", (event) => this._onHandleDown(event, dir));
      this.overlay.appendChild(el);
      return el;
    });

    app.host.appendChild(this.overlay);
    // Handles are positioned in screen space, so they have to be repositioned
    // whenever the view moves under them
    app.host.addEventListener("scene:transform", () => this.refresh());
  }

  // ── Bounds ────────────────────────────────
  boundsOf(ids) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const el = this.app.store.find(id);
      if (!el) continue;
      const box = el.kind
        ? SpatialIndex.bboxOf(el)
        : { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h };
      minX = Math.min(minX, box.minX);
      minY = Math.min(minY, box.minY);
      maxX = Math.max(maxX, box.maxX);
      maxY = Math.max(maxY, box.maxY);
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  /** True when a scene point falls inside the current selection bounds. */
  contains(point) {
    if (!this.app.selection.size) return false;
    const b = this.boundsOf([...this.app.selection]);
    return !!b
      && point.x >= b.minX && point.x <= b.maxX
      && point.y >= b.minY && point.y <= b.maxY;
  }

  refresh() {
    const ids = [...this.app.selection];
    const bounds = ids.length ? this.boundsOf(ids) : null;

    if (!bounds) {
      this.overlay.hidden = true;
      return;
    }

    // Scene coordinates to viewport pixels
    const sceneRect = this.scene.sceneEl.getBoundingClientRect();
    const hostRect = this.app.host.getBoundingClientRect();
    const scale = this.scene.scale;
    const left = sceneRect.left - hostRect.left + bounds.minX * scale;
    const top = sceneRect.top - hostRect.top + bounds.minY * scale;
    const width = (bounds.maxX - bounds.minX) * scale;
    const height = (bounds.maxY - bounds.minY) * scale;

    this.overlay.hidden = false;
    Object.assign(this.box.style, {
      left: `${left}px`, top: `${top}px`,
      width: `${width}px`, height: `${height}px`,
    });

    this.handles.forEach((el, i) => {
      const dir = DIRECTIONS[i];
      el.style.left = `${left + ((dir.x + 1) / 2) * width}px`;
      el.style.top = `${top + ((dir.y + 1) / 2) * height}px`;
    });
  }

  // ── Resize ────────────────────────────────
  _onHandleDown(event, dir) {
    if (event.button !== 0) return;
    // The canvas must not also treat this as a click on empty space
    event.preventDefault();
    event.stopPropagation();

    this.direction = [dir.x, dir.y];
    this.resizing = true;
    // Expensive objects stretch what they already drew while this is set
    this.app.transforming = true;
    this._begin(this.scene.toScene(event.clientX, event.clientY));

    // Listening on window means the gesture survives the pointer leaving the
    // handle, which it does immediately on any real drag
    const move = (e) => this._resize(this.scene.toScene(e.clientX, e.clientY));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this.resizing = false;
      this._commit("Resize");
      this._settle();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // ── Move ──────────────────────────────────
  beginMove(point) {
    if (!this.app.selection.size) return false;
    this._begin(point);
    this.moving = true;
    return true;
  }

  moveTo(point) {
    if (this.moving) this._move(point);
  }

  endMove() {
    if (!this.moving) return;
    this.moving = false;
    this._commit("Move");
  }

  /**
   * Drag over: let anything that was stretched redraw itself properly.
   * A 3D plot costs ~113ms to rebuild, so it is scaled with a CSS transform
   * during the drag and rebuilt once, here.
   */
  _settle() {
    this.app.transforming = false;
    for (const id of this.app.selection) {
      const element = this.app.store.find(id);
      if (element && !element.kind) this.scene.objects.render(element);
    }
  }

  // ── Gesture internals ─────────────────────
  _begin(point) {
    const ids = [...this.app.selection];
    this.snapshot = {
      ids,
      bounds: this.boundsOf(ids),
      start: point,
      // Deep copies, so every frame transforms the ORIGINAL geometry.
      // Transforming the live geometry each frame lets rounding error
      // accumulate over a long drag and slowly warp the strokes.
      elements: ids.map((id) => JSON.parse(JSON.stringify(this.app.store.find(id)))),
    };
  }

  _move(now) {
    if (!this.snapshot) return;
    const dx = now.x - this.snapshot.start.x;
    const dy = now.y - this.snapshot.start.y;

    this._apply((el) => {
      if (el.kind) {
        const points = el.points.slice();
        for (let i = 0; i < points.length; i += el.stride) {
          points[i] += dx;
          points[i + 1] += dy;
        }
        return { points };
      }
      return { x: el.x + dx, y: el.y + dy };
    });
  }

  _resize(now) {
    if (!this.snapshot?.bounds) return;
    const orig = this.snapshot.bounds;
    const [dirX, dirY] = this.direction;

    const MIN = 12;                              // never collapse or invert
    const origW = (orig.maxX - orig.minX) || 1;
    const origH = (orig.maxY - orig.minY) || 1;
    let left, top, right, bottom;

    if (dirX !== 0 && dirY !== 0) {
      // Corner: one scale factor drives both axes, anchored on the opposite
      // corner, so the stroke keeps its shape instead of being stretched.
      // Taking the larger of the two candidate scales means the box follows
      // whichever way you drag furthest, rather than only tracking one axis.
      const anchorX = dirX < 0 ? orig.maxX : orig.minX;
      const anchorY = dirY < 0 ? orig.maxY : orig.minY;

      const scale = Math.max(
        Math.abs(now.x - anchorX) / origW,
        Math.abs(now.y - anchorY) / origH,
        MIN / origW,
        MIN / origH,
      );

      const width = origW * scale;
      const height = origH * scale;
      left = dirX < 0 ? anchorX - width : anchorX;
      top = dirY < 0 ? anchorY - height : anchorY;
      right = left + width;
      bottom = top + height;
    } else {
      // Edge: single axis, the other left exactly as it was
      ({ minX: left, minY: top, maxX: right, maxY: bottom } = orig);
      if (dirX < 0) left = now.x;
      if (dirX > 0) right = now.x;
      if (dirY < 0) top = now.y;
      if (dirY > 0) bottom = now.y;

      if (right - left < MIN) (dirX < 0 ? (left = right - MIN) : (right = left + MIN));
      if (bottom - top < MIN) (dirY < 0 ? (top = bottom - MIN) : (bottom = top + MIN));
    }

    const sx = (right - left) / origW;
    const sy = (bottom - top) / origH;
    // Nib width follows the overall scale, so shrunk ink doesn't go blobby
    const penScale = Math.sqrt(Math.abs(sx * sy));

    this._apply((el) => {
      if (el.kind) {
        const points = el.points.slice();
        for (let i = 0; i < points.length; i += el.stride) {
          points[i] = left + (points[i] - orig.minX) * sx;
          points[i + 1] = top + (points[i + 1] - orig.minY) * sy;
        }
        return {
          points,
          style: { ...el.style, size: Math.max(0.5, el.style.size * penScale) },
        };
      }
      return {
        x: left + (el.x - orig.minX) * sx,
        y: top + (el.y - orig.minY) * sy,
        w: Math.max(24, el.w * sx),
        h: Math.max(24, el.h * sy),
      };
    });
  }

  /** Apply a transform to the snapshot and push it straight to the store. */
  _apply(fn) {
    this.app.store.patchMany(
      this.snapshot.elements.map((el) => ({ id: el.id, changes: fn(el) })),
    );
    this.refresh();
  }

  _commit(label) {
    if (!this.snapshot) return;
    const entries = this.snapshot.elements
      .map((before) => {
        const after = this.app.store.find(before.id);
        if (!after) return null;
        return before.kind
          ? { id: before.id,
              before: { points: before.points, style: before.style },
              after: { points: after.points.slice(), style: { ...after.style } } }
          : { id: before.id,
              before: { x: before.x, y: before.y, w: before.w, h: before.h },
              after: { x: after.x, y: after.y, w: after.w, h: after.h } };
      })
      .filter(Boolean);

    this.snapshot = null;
    if (!entries.length) return;

    const changed = entries.some(
      (e) => JSON.stringify(e.before) !== JSON.stringify(e.after));
    if (!changed) return;

    // The live gesture already mutated the store, so record it as one
    // undoable command without re-running the change
    this.app.history.record(patchElements(entries, label));
  }

  destroy() {
    this.overlay.remove();
  }
}
