import polygonClipping from "polygon-clipping";
import { strokeHit } from "../canvas/spatial.js";
import { createStroke } from "../model/document.js";

// ─────────────────────────────────────────────
//  ERASER
//
//  Two modes:
//    "stroke"  — removes any stroke it touches
//    "partial" — cuts away only what it covers
//
//  Partial erase records the swept area as a
//  SUBTRACTIVE MASK on the stroke rather than
//  rewriting its points. The input points stay
//  untouched, so an erased stroke can still be
//  recoloured, re-thickened and rescaled, and
//  undo is just dropping the mask again.
// ─────────────────────────────────────────────
const CIRCLE_SEGMENTS = 16;

function circleRing(cx, cy, radius) {
  const ring = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    ring.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  ring.push(ring[0]);   // closed
  return ring;
}

function ringBounds(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y)
        && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const pointInMask = (x, y, rings) => rings.some((r) => pointInRing(x, y, r));

/**
 * Cut a stroke's point list where the mask covers it.
 *
 * Returns the surviving runs. Segments that cross the mask are sampled
 * first, because a fast stroke stores few points and a gap between two
 * points either side of the eraser would otherwise go unnoticed.
 */
function splitPoints(points, stride, rings, sampleStep) {
  const masked = rings.map(ringBounds);
  const nearMask = (x1, y1, x2, y2) => masked.some((b) =>
    Math.min(x1, x2) <= b.maxX && Math.max(x1, x2) >= b.minX
    && Math.min(y1, y2) <= b.maxY && Math.max(y1, y2) >= b.minY);

  const samples = [];
  const push = (x, y, p) => samples.push({ x, y, p, cut: pointInMask(x, y, rings) });

  push(points[0], points[1], points[2] ?? 0.5);
  for (let i = 0; i + stride < points.length; i += stride) {
    const [ax, ay, ap] = [points[i], points[i + 1], points[i + 2] ?? 0.5];
    const [bx, by, bp] = [points[i + stride], points[i + stride + 1],
                          points[i + stride + 2] ?? 0.5];

    if (nearMask(ax, ay, bx, by)) {
      const distance = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(distance / sampleStep));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        push(ax + (bx - ax) * t, ay + (by - ay) * t, ap + (bp - ap) * t);
      }
    }
    push(bx, by, bp);
  }

  const runs = [];
  let current = [];
  for (const sample of samples) {
    if (sample.cut) {
      if (current.length >= 2) runs.push(current);
      current = [];
    } else {
      current.push(sample);
    }
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}

const flatten = (run) => {
  const out = new Array(run.length * 3);
  run.forEach((s, i) => {
    out[i * 3] = s.x;
    out[i * 3 + 1] = s.y;
    out[i * 3 + 2] = s.p;
  });
  return out;
};

export class EraserTool {
  constructor(app, mode = "stroke") {
    this.app = app;
    this.mode = mode;
    this.cursor = "none";       // the ring on the canvas is the cursor
    this.active = false;
  }

  get radius() {
    return this.app.settings.eraser.size / 2;
  }

  // ── Gesture ───────────────────────────────
  onPointerDown(event, point) {
    if (event.button !== 0) return;
    this.active = true;
    this.lastPoint = point;

    this.removed = [];          // snapshots, for undo
    this.removedIds = new Set();
    this.originalMasks = new Map();    // id -> erase array as it was
    this.originalStrokes = new Map();  // id -> the whole stroke, pre-gesture
    this.masks = new Map();            // id -> rings added by this swipe

    this._eraseAt(point);
  }

  onPointerMove(event, point) {
    this._drawRing(point);
    if (!this.active) return;

    // A fast swipe arrives as a few long jumps. Without filling them in the
    // eraser punches a dotted line instead of a continuous one.
    const last = this.lastPoint ?? point;
    const distance = Math.hypot(point.x - last.x, point.y - last.y);
    const steps = Math.max(1, Math.ceil(distance / (this.radius / 2)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this._eraseAt({
        x: last.x + (point.x - last.x) * t,
        y: last.y + (point.y - last.y) * t,
      });
    }
    this.lastPoint = point;
  }

  onPointerUp() {
    if (!this.active) return;
    this.active = false;
    this.lastPoint = null;
    this._commit();
  }

  onCancel() {
    this.active = false;
    this.lastPoint = null;
    this.app.scene.clearChrome();
  }

  // ── Erasing ───────────────────────────────
  _targets(point) {
    const reach = this.radius;
    const ids = this.app.scene.index.near(point.x, point.y, reach + 4);
    const hits = [];
    for (const id of ids) {
      if (this.removedIds.has(id)) continue;
      const stroke = this.app.store.find(id);
      // Only ink erases. A LaTeX box shouldn't be destroyed by a swipe
      // across it — delete those with the selection tools.
      if (stroke?.kind && this.app.isInteractive(stroke)
          && strokeHit(stroke, point.x, point.y, reach)) {
        hits.push(stroke);
      }
    }
    return hits;
  }

  _eraseAt(point) {
    for (const stroke of this._targets(point)) {
      if (this.mode === "stroke") {
        this.removed.push(JSON.parse(JSON.stringify(stroke)));
        this.removedIds.add(stroke.id);
        this.app.store.removeMany([stroke.id]);
      } else {
        this._addMask(stroke, point);
      }
    }
  }

  _addMask(stroke, point) {
    if (!this.originalMasks.has(stroke.id)) {
      this.originalMasks.set(stroke.id, stroke.erase ?? []);
      this.originalStrokes.set(stroke.id, JSON.parse(JSON.stringify(stroke)));
      this.masks.set(stroke.id, []);
    }

    const circle = circleRing(point.x, point.y, this.radius);
    const existing = this.masks.get(stroke.id);

    // Merge as we go, so a long swipe stays a couple of rings rather than
    // hundreds of overlapping circles the renderer has to subtract one by one
    let rings;
    try {
      const merged = existing.length
        ? polygonClipping.union(existing.map((r) => [r]), [circle])
        : [[circle]];
      rings = merged.map((polygon) => polygon[0]);
    } catch {
      rings = [...existing, circle];   // a degenerate union shouldn't stop erasing
    }

    this.masks.set(stroke.id, rings);
    this.app.store.patch(stroke.id, {
      erase: [...this.originalMasks.get(stroke.id), ...rings],
    });
  }

  // ── Undo ──────────────────────────────────
  _commit() {
    if (this.mode === "stroke") {
      if (!this.removed.length) return;
      const snapshot = this.removed;
      const ids = snapshot.map((s) => s.id);
      this.app.history.record({
        label: "Erase",
        redo: (store) => store.removeMany(ids),
        undo: (store) => store.insertMany(JSON.parse(JSON.stringify(snapshot))),
      });
      return;
    }

    // Partial erase: turn the masked stroke into real, separate strokes.
    //
    // The mask alone would leave one stroke that merely LOOKS broken, so the
    // whole-stroke eraser would still swallow all the pieces at once, and
    // selecting one piece would grab the lot. Splitting for real means each
    // surviving piece is a first-class stroke you can erase, select, move,
    // restyle and rescale on its own.
    const removedIds = [];
    const originals = [];
    const created = [];

    for (const [id, rings] of this.masks) {
      if (!rings.length) continue;
      const stroke = this.app.store.find(id);
      if (!stroke) continue;

      const original = this.originalStrokes.get(id);
      const originalErase = this.originalMasks.get(id);
      const runs = splitPoints(original.points, original.stride, rings,
                               Math.max(1.5, this.radius / 3));

      const pieces = runs.map((run) => {
        const piece = createStroke({
          kind: original.kind,
          points: flatten(run),
          style: { ...original.style },
          page: original.page,
        });
        piece.z = original.z;
        piece.layerId = original.layerId;   // pieces stay where the stroke was
        // Earlier masks stay only where they still overlap this piece; the
        // rings from THIS swipe are already baked into the split
        piece.erase = originalErase.filter((ring) => {
          const b = ringBounds(ring);
          return run.some((s2) => s2.x >= b.minX && s2.x <= b.maxX
                               && s2.y >= b.minY && s2.y <= b.maxY);
        });
        return piece;
      });

      removedIds.push(id);
      originals.push(original);
      created.push(...pieces);
    }

    if (!removedIds.length) return;

    const createdIds = created.map((p) => p.id);
    const clone = (value) => JSON.parse(JSON.stringify(value));

    // Apply the swap for real: the live preview was the masked original
    this.app.store.removeMany(removedIds);
    this.app.store.insertMany(clone(created));

    this.app.history.record({
      label: "Erase",
      redo: (store) => {
        store.removeMany(removedIds);
        store.insertMany(clone(created));
      },
      undo: (store) => {
        store.removeMany(createdIds);
        store.insertMany(clone(originals));
      },
    });
  }

  // ── The ring you aim with ─────────────────
  _drawRing(point) {
    const scene = this.app.scene;
    scene.clearChrome();
    const ring = circleRing(point.x, point.y, this.radius);
    const d = `M ${ring[0][0]} ${ring[0][1]} `
      + ring.slice(1).map(([x, y]) => `L ${x} ${y}`).join(" ") + " Z";
    scene.drawPath(d, "ntbk-eraser-ring");
  }
}
