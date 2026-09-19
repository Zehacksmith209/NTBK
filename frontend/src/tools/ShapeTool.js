import { createStroke } from "../model/document.js";
import { addElements } from "../model/history.js";

// ─────────────────────────────────────────────
//  SHAPES
//
//  A shape is a stroke whose points happen to be
//  geometric. That is the whole design: it means
//  the eraser cuts it, the lasso catches it, the
//  colour and thickness pickers restyle it and
//  the handles resize it, all without a line of
//  new code — because it is ink.
//
//  Drawn with constant width and no taper, or a
//  circle comes out looking like a wobbly hand
//  drawing rather than a circle.
// ─────────────────────────────────────────────
export const SHAPE_KINDS = ["line", "arrow", "rect", "ellipse", "triangle"];

export const SHAPE_LABELS = {
  line: "Line", arrow: "Arrow", rect: "Rectangle",
  ellipse: "Ellipse", triangle: "Triangle",
};

const ELLIPSE_STEPS = 72;

/** Points for a shape spanning the box from `a` to `b`. */
export function shapePoints(kind, a, b) {
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  const points = [];

  switch (kind) {
    case "line":
      points.push([a.x, a.y], [b.x, b.y]);
      break;

    case "arrow": {
      // One polyline that retraces itself to draw the head — a stroke is a
      // single path, and with round joins the retrace is invisible
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const head = Math.max(8, Math.min(26, length * 0.22));
      const spread = 0.42;
      points.push([a.x, a.y], [b.x, b.y]);
      points.push([b.x - Math.cos(angle - spread) * head,
                   b.y - Math.sin(angle - spread) * head]);
      points.push([b.x, b.y]);
      points.push([b.x - Math.cos(angle + spread) * head,
                   b.y - Math.sin(angle + spread) * head]);
      break;
    }

    case "rect":
      points.push([left, top], [right, top], [right, bottom],
                  [left, bottom], [left, top]);
      break;

    case "triangle":
      points.push([(left + right) / 2, top], [right, bottom],
                  [left, bottom], [(left + right) / 2, top]);
      break;

    case "ellipse": {
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      const rx = (right - left) / 2, ry = (bottom - top) / 2;
      for (let i = 0; i <= ELLIPSE_STEPS; i++) {
        const t = (i / ELLIPSE_STEPS) * Math.PI * 2;
        points.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
      }
      break;
    }
    default:
      points.push([a.x, a.y], [b.x, b.y]);
  }

  // Flat [x, y, pressure] triples, constant pressure — a shape has no
  // pressure profile
  const flat = new Array(points.length * 3);
  points.forEach(([x, y], i) => {
    flat[i * 3] = x;
    flat[i * 3 + 1] = y;
    flat[i * 3 + 2] = 0.5;
  });
  return flat;
}

/** Hold shift to square up a box, or snap a line to 45 degrees. */
function constrain(kind, a, b) {
  if (kind === "line" || kind === "arrow") {
    const dx = b.x - a.x, dy = b.y - a.y;
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const length = Math.hypot(dx, dy);
    return { x: a.x + Math.cos(angle) * length, y: a.y + Math.sin(angle) * length };
  }
  const size = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return {
    x: a.x + Math.sign(b.x - a.x || 1) * size,
    y: a.y + Math.sign(b.y - a.y || 1) * size,
  };
}

export class ShapeTool {
  constructor(app, kind = "rect") {
    this.app = app;
    this.kind = kind;
    this.cursor = "crosshair";
    this.start = null;
    this.live = null;
  }

  get style() {
    const { color, size } = this.app.settings.shape;
    return {
      color, size, opacity: 1,
      // Constant width, sharp corners, no lag — the opposite of handwriting
      thinning: 0,
      smoothing: 0,
      streamline: 0,
      taperStart: 0,
      taperEnd: 0,
      simulatePressure: false,
      blend: "normal",
    };
  }

  onPointerDown(event, point) {
    if (event.button !== 0) return;
    this.start = point;
    this.live = createStroke({
      kind: "shape",
      points: shapePoints(this.kind, point, point),
      style: this.style,
    });
    this.live.shape = this.kind;   // kept so it can become parametric later
    this.app.scene.ink.render(this.live);
  }

  onPointerMove(event, point) {
    if (!this.start) return;
    const end = event.shiftKey ? constrain(this.kind, this.start, point) : point;
    this.live.points = shapePoints(this.kind, this.start, end);
    this.app.scene.ink.render(this.live);
  }

  onPointerUp(event, point) {
    if (!this.start) return;
    const end = event.shiftKey ? constrain(this.kind, this.start, point) : point;
    const start = this.start;
    const live = this.live;
    this.start = null;
    this.live = null;
    this.app.scene.ink.remove(live.id);

    // A click without a drag isn't a shape
    if (Math.hypot(end.x - start.x, end.y - start.y) < 3) return;

    const stroke = createStroke({
      kind: "shape",
      points: shapePoints(this.kind, start, end),
      style: this.style,
    });
    stroke.shape = this.kind;
    this.app.history.run(addElements([stroke], SHAPE_LABELS[this.kind] ?? "Shape"));
  }

  onCancel() {
    if (this.live) this.app.scene.ink.remove(this.live.id);
    this.start = null;
    this.live = null;
  }
}
