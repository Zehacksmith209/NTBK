import RBush from "rbush";

// ─────────────────────────────────────────────
//  SPATIAL INDEX
//
//  The ink layer is pointer-events:none — it has
//  to be, because it sits above the object layer
//  and would otherwise swallow every click meant
//  for a box. So strokes can't be hit-tested by
//  the DOM and we index them ourselves.
// ─────────────────────────────────────────────
export class SpatialIndex {
  constructor() {
    this.tree = new RBush();
    this.entries = new Map(); // id -> entry
  }

  static bboxOf(stroke) {
    const { points, stride, style } = stroke;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i += stride) {
      const x = points[i], y = points[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    // Points are the spine of the stroke; the drawn outline extends by
    // roughly half the nib width either side, so pad by that.
    const pad = (style?.size ?? 2) / 2 + 1;
    return {
      minX: minX - pad, minY: minY - pad,
      maxX: maxX + pad, maxY: maxY + pad,
    };
  }

  insert(stroke) {
    this.remove(stroke.id);
    const entry = { ...SpatialIndex.bboxOf(stroke), id: stroke.id };
    this.tree.insert(entry);
    this.entries.set(stroke.id, entry);
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.tree.remove(entry, (a, b) => a.id === b.id);
    this.entries.delete(id);
  }

  clear() {
    this.tree.clear();
    this.entries.clear();
  }

  rebuild(strokes) {
    this.clear();
    for (const stroke of strokes) this.insert(stroke);
  }

  /** Candidate ids whose bounding box overlaps the rect. */
  search(minX, minY, maxX, maxY) {
    return this.tree.search({ minX, minY, maxX, maxY }).map((e) => e.id);
  }

  /** Candidate ids near a point, within `radius` scene units. */
  near(x, y, radius) {
    return this.search(x - radius, y - radius, x + radius, y + radius);
  }
}

/** Squared distance from a point to a line segment. */
function distSqToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/**
 * Precise hit test against a stroke's spine.
 * Bounding boxes get you candidates; this decides.
 */
export function strokeHit(stroke, x, y, tolerance = 0) {
  const { points, stride } = stroke;
  const reach = (stroke.style?.size ?? 2) / 2 + tolerance;
  const reachSq = reach * reach;

  if (points.length < stride * 2) {
    const dx = x - points[0], dy = y - points[1];
    return dx * dx + dy * dy <= reachSq;
  }

  for (let i = 0; i < points.length - stride; i += stride) {
    if (distSqToSegment(x, y,
          points[i], points[i + 1],
          points[i + stride], points[i + stride + 1]) <= reachSq) {
      return true;
    }
  }
  return false;
}

/** True when every point of the stroke lies inside the rect. */
export function strokeInsideRect(stroke, rect) {
  const { points, stride } = stroke;
  for (let i = 0; i < points.length; i += stride) {
    const x = points[i], y = points[i + 1];
    if (x < rect.minX || x > rect.maxX || y < rect.minY || y > rect.maxY) {
      return false;
    }
  }
  return true;
}
