import { PX_PER_MM, createStroke } from "../model/document.js";
import { addElements } from "../model/history.js";
import { svg, wireHandles, inView, viewCentre } from "./Instruments.js";

// ─────────────────────────────────────────────
//  COMPASS
//
//  A point that stays put and a pencil that goes
//  round it.
//
//  Three things can be held: the point (moves
//  the compass), the square at the far end (sets
//  how wide it is open), and the pencil — drag
//  that and it draws, as far round as you take
//  it. All the way round is a circle.
//
//  What it draws is ordinary ink in the pen's
//  colour and thickness, so the eraser and the
//  lasso treat it like anything else drawn.
// ─────────────────────────────────────────────
const PX_PER_CM = PX_PER_MM * 10;
const MIN_RADIUS = 4;
const MAX_RADIUS = 40 * PX_PER_CM;
const TAU = Math.PI * 2;

/** How far past the pencil the width handle sits, in screen pixels. */
const WIDTH_HANDLE_GAP = 26;

/** Points on a circle from one angle to another, close enough to read as a curve. */
export function arcPoints(cx, cy, radius, from, to) {
  const sweep = to - from;
  // Chords of about two and a half scene units, within sensible bounds
  const step = Math.min((3 * Math.PI) / 180, Math.max((0.5 * Math.PI) / 180, 2.5 / radius));
  const count = Math.max(2, Math.ceil(Math.abs(sweep) / step) + 1);
  const flat = new Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = from + (sweep * i) / (count - 1);
    flat[i * 3] = cx + Math.cos(angle) * radius;
    flat[i * 3 + 1] = cy + Math.sin(angle) * radius;
    flat[i * 3 + 2] = 0.5;
  }
  return flat;
}

export class Compass {
  constructor(app) {
    this.app = app;
    // Scene coordinates of the point, how wide it is open in scene units, and
    // the direction the pencil lies in, in radians.
    this.x = 0;
    this.y = 0;
    this.radius = 3 * PX_PER_CM;
    this.direction = -Math.PI / 4;
    this.visible = false;
    this.placed = false;
    this.live = null;

    this.el = document.createElement("div");
    this.el.className = "ntbk-instrument ntbk-compass";
    this.el.hidden = true;
    const root = svg("svg", { class: "ntbk-instrument-svg", width: 1, height: 1 }, this.el);
    this.circle = svg("circle", { class: "ntbk-compass-guide", cx: 0, cy: 0 }, root);
    this.leg = svg("line", { class: "ntbk-compass-leg", x1: 0, y1: 0 }, root);
    this.label = svg("g", { class: "ntbk-compass-label" }, root);
    this.labelBox = svg("rect", { x: -26, y: -9, width: 52, height: 18, rx: 9, ry: 9 }, this.label);
    this.labelText = svg("text", {}, this.label);

    this.point = svg("g", { class: "ntbk-compass-point", "data-grip": "move" }, root);
    this.pointRing = svg("circle", { cx: 0, cy: 0 }, this.point);
    this.pointDot = svg("circle", { class: "is-dot", cx: 0, cy: 0 }, this.point);
    svg("title", {}, this.point).textContent = "The point. Drag to move the compass.";

    this.width = svg("rect", { class: "ntbk-instrument-knob is-square", "data-grip": "width" }, root);
    svg("title", {}, this.width).textContent =
      "Drag to open or close the compass. Hold Shift for half-centimetre steps.";
    this.pencil = svg("circle", { class: "ntbk-compass-pencil", "data-grip": "draw" }, root);
    svg("title", {}, this.pencil).textContent =
      "The pencil. Drag it round to draw. Hold Shift for 15° steps.";

    wireHandles(this.el, app, {
      move: (point) => {
        const from = { x: this.x - point.x, y: this.y - point.y };
        return { move: (p) => { this.x = p.x + from.x; this.y = p.y + from.y; this.place(); } };
      },
      width: (point) => {
        // Kept under the finger: the handle sits a little past the pencil
        const slack = Math.hypot(point.x - this.x, point.y - this.y) - this.radius;
        return {
          move: (p, event) => {
            let radius = Math.hypot(p.x - this.x, p.y - this.y) - slack;
            if (event.shiftKey) radius = Math.round(radius / (PX_PER_CM / 2)) * (PX_PER_CM / 2);
            this.radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius));
            this.direction = Math.atan2(p.y - this.y, p.x - this.x);
            this.place();
          },
        };
      },
      draw: () => this._beginSwing(),
    });

    app.host.appendChild(this.el);
    app.host.addEventListener("scene:transform", () => this.place());
  }

  get radiusCm() { return this.radius / PX_PER_CM; }

  setRadiusCm(cm) {
    const value = Number(cm);
    if (!Number.isFinite(value)) return;
    this.radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, value * PX_PER_CM));
    this.place();
  }

  /** Constant width and no taper, in whatever the pen is currently set to. */
  _style() {
    const { color, size } = this.app.settings.pen;
    return {
      color, size, opacity: 1,
      thinning: 0, smoothing: 0, streamline: 0, taperStart: 0, taperEnd: 0,
      simulatePressure: false, blend: "normal",
    };
  }

  /**
   * One swing of the pencil.
   *
   * The turn is added up as it goes rather than read off the pointer each
   * time, because an angle on its own cannot tell 350° round from 10° back.
   * The ink covers everywhere the pencil has been, in either direction, and
   * stops growing at one full turn.
   */
  _beginSwing() {
    const start = this.direction;
    let turned = 0, low = 0, high = 0;
    let last = start;

    const span = () => {
      if (high - low >= TAU) return [start, start + TAU];
      return [start + low, start + high];
    };

    return {
      move: (p, event) => {
        const now = Math.atan2(p.y - this.y, p.x - this.x);
        let delta = now - last;
        if (delta > Math.PI) delta -= TAU;
        if (delta < -Math.PI) delta += TAU;
        last = now;
        turned += delta;
        let shown = turned;
        if (event.shiftKey) {
          const step = (15 * Math.PI) / 180;
          shown = Math.round(turned / step) * step;
        }
        low = Math.min(low, shown);
        high = Math.max(high, shown);
        this.direction = start + shown;
        this.place();

        const [from, to] = span();
        if (to - from < 0.004) return;
        const points = arcPoints(this.x, this.y, this.radius, from, to);
        if (!this.live) {
          this.live = createStroke({ kind: "shape", points, style: this._style() });
        } else {
          this.live.points = points;
        }
        this.app.scene.ink.render(this.live);
      },
      end: (cancelled) => {
        const live = this.live;
        this.live = null;
        if (live) this.app.scene.ink.remove(live.id);
        const [from, to] = span();
        // A press that never went anywhere is not an arc
        if (cancelled || (to - from) * this.radius < 2) return;
        this._commit(from, to);
      },
    };
  }

  _commit(from, to) {
    const whole = to - from >= TAU - 1e-9;
    const stroke = createStroke({
      kind: "shape",
      points: arcPoints(this.x, this.y, this.radius, from, to),
      style: this._style(),
    });
    stroke.shape = whole ? "circle" : "arc";
    this.app.history.run(addElements([this.app.adopt(stroke)], whole ? "Circle" : "Arc"));
  }

  /** The whole circle in one go, for when there is no need to swing it by hand. */
  drawCircle() {
    if (!this.visible) this.show();
    this._commit(this.direction, this.direction + TAU);
  }

  show() {
    // Put back where it was left, unless that is no longer on screen
    if (!this.placed || !inView(this.app, this.x, this.y)) {
      const centre = viewCentre(this.app);
      this.x = centre.x;
      this.y = centre.y;
      this.placed = true;
    }
    this.visible = true;
    this.el.hidden = false;
    this.place();
  }

  hide() {
    this.visible = false;
    this.el.hidden = true;
  }

  toggle() {
    if (this.visible) this.hide(); else this.show();
    return this.visible;
  }

  place() {
    if (!this.visible) return;
    const { scale, view } = this.app.scene;
    this.el.style.transform =
      `translate(${this.x * scale + view.x}px, ${this.y * scale + view.y}px) scale(${scale})`;

    const r = this.radius;
    const k = 1 / scale;               // handles keep their size on screen
    const cos = Math.cos(this.direction), sin = Math.sin(this.direction);
    const px = cos * r, py = sin * r;

    this.circle.setAttribute("r", r);
    this.leg.setAttribute("x2", px);
    this.leg.setAttribute("y2", py);
    this.pencil.setAttribute("cx", px);
    this.pencil.setAttribute("cy", py);
    this.pencil.setAttribute("r", 8 * k);
    this.pencil.style.fill = this.app.settings.pen.color;

    this.pointRing.setAttribute("r", 11 * k);
    this.pointDot.setAttribute("r", 1.8 * k);

    const side = 13 * k;
    const wx = cos * (r + WIDTH_HANDLE_GAP * k), wy = sin * (r + WIDTH_HANDLE_GAP * k);
    this.width.setAttribute("x", wx - side / 2);
    this.width.setAttribute("y", wy - side / 2);
    this.width.setAttribute("width", side);
    this.width.setAttribute("height", side);
    this.width.setAttribute("rx", 3 * k);
    this.width.setAttribute("transform",
      `rotate(${(this.direction * 180) / Math.PI} ${wx} ${wy})`);

    this.labelText.textContent = `${this.radiusCm.toFixed(1)} cm`;
    // Beside the leg rather than on it, so it does not hide what is underneath
    const lx = px / 2 - sin * 14 * k, ly = py / 2 + cos * 14 * k;
    this.label.setAttribute("transform", `translate(${lx} ${ly}) scale(${k})`);
    // When it is nearly closed there is no room for the label on the leg
    this.label.style.display = r * scale < 34 ? "none" : "";
  }

  destroy() { this.el.remove(); }
}
