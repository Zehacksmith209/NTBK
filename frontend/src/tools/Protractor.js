import { PX_PER_MM } from "../model/document.js";
import { SNAP_DISTANCE, svg, wireHandles, inView, viewCentre } from "./Instruments.js";

// ─────────────────────────────────────────────
//  PROTRACTOR
//
//  A half-circle laid on the page, with one arm
//  that swings round it.
//
//  Measuring: put the centre on the corner, turn
//  the base onto one side and the arm onto the
//  other, and read the number.
//
//  Drawing: set the arm to the angle and run the
//  pen along it. The pen also follows the base
//  and the curved edge.
//
//  Unlike the ruler it is clear all the way
//  through: the corner being measured is under
//  it, and has to stay visible and drawable.
// ─────────────────────────────────────────────
const PX_PER_CM = PX_PER_MM * 10;

/** How far past the rim the arm reaches, in scene units, so a line can run on. */
const ARM_REACH = 70;

/** Two edges this close in screen pixels are not yet told apart. */
const UNDECIDED = 6;

export class Protractor {
  constructor(app) {
    this.app = app;
    this.radiusCm = 5;
    // Scene coordinates of the centre mark, the turn of the whole thing in
    // degrees (0 has the base level and the dome upward), and the arm's
    // reading: degrees anticlockwise from the right-hand end of the base, the
    // way a protractor's outer scale counts.
    this.x = 0;
    this.y = 0;
    this.angle = 0;
    this.arm = 60;
    this.visible = false;
    this.placed = false;
    this._locked = null;

    this.el = document.createElement("div");
    this.el.className = "ntbk-instrument ntbk-protractor";
    this.el.hidden = true;
    this._build();
    wireHandles(this.el, app, {
      move: (point) => {
        const from = { x: this.x - point.x, y: this.y - point.y };
        return { move: (p) => { this.x = p.x + from.x; this.y = p.y + from.y; this.place(); } };
      },
      rotate: () => ({
        move: (p, event) => {
          const degrees = (Math.atan2(p.y - this.y, p.x - this.x) * 180) / Math.PI;
          // Shift locks to 15° steps, the same as turning the ruler
          this.angle = event.shiftKey ? Math.round(degrees / 15) * 15 : degrees;
          this.place();
        },
      }),
      arm: () => ({
        move: (p, event) => {
          this.setArm(this._readingAt(p), event.shiftKey ? 15 : 1);
        },
      }),
    });

    app.host.appendChild(this.el);
    app.host.addEventListener("scene:transform", () => this.place());
  }

  get radius() { return this.radiusCm * PX_PER_CM; }

  /** Unit vectors along the base, and from the base toward the top of the dome. */
  _axes() {
    const radians = (this.angle * Math.PI) / 180;
    const dx = Math.cos(radians), dy = Math.sin(radians);
    return { dx, dy, nx: dy, ny: -dx };
  }

  /** A scene point in the protractor's own frame: along the base, and up into the dome. */
  _local(point) {
    const { dx, dy, nx, ny } = this._axes();
    const px = point.x - this.x, py = point.y - this.y;
    return { along: px * dx + py * dy, up: px * nx + py * ny };
  }

  _scene(along, up) {
    const { dx, dy, nx, ny } = this._axes();
    return { x: this.x + dx * along + nx * up, y: this.y + dy * along + ny * up };
  }

  /** The reading under a point, held to the half-circle the scale covers. */
  _readingAt(point) {
    const { along, up } = this._local(point);
    const degrees = (Math.atan2(up, along) * 180) / Math.PI;
    if (degrees >= 0) return degrees;
    return degrees > -90 ? 0 : 180;      // below the base: whichever end is nearer
  }

  setArm(degrees, step = 0) {
    let value = Math.min(180, Math.max(0, Number(degrees) || 0));
    if (step) value = Math.round(value / step) * step;
    this.arm = value;
    this.place();
  }

  setRadius(cm) {
    this.radiusCm = Math.min(15, Math.max(3, Number(cm) || 5));
    this._build();
    this.place();
  }

  _build() {
    const R = this.radius;
    const pad = ARM_REACH + 40;
    const size = (R + pad) * 2;
    this.el.innerHTML = "";
    const root = svg("svg", {
      class: "ntbk-instrument-svg",
      viewBox: `${-(R + pad)} ${-(R + pad)} ${size} ${size}`,
      width: size, height: size,
    }, this.el);
    root.style.left = `${-(R + pad)}px`;
    root.style.top = `${-(R + pad)}px`;

    svg("path", { class: "ntbk-protractor-body",
                  d: `M ${-R} 0 A ${R} ${R} 0 0 1 ${R} 0 Z` }, root);

    // Marks every degree, longer on the fives and tens, numbered on the tens
    // in both directions so an angle can be read from either end of the base.
    const ticks = svg("g", { class: "ntbk-protractor-ticks" }, root);
    for (let degree = 0; degree <= 180; degree++) {
      const a = (degree * Math.PI) / 180;
      const cos = Math.cos(a), sin = -Math.sin(a);
      const length = degree % 10 === 0 ? 14 : degree % 5 === 0 ? 10 : 6;
      svg("line", {
        x1: (cos * R).toFixed(2), y1: (sin * R).toFixed(2),
        x2: (cos * (R - length)).toFixed(2), y2: (sin * (R - length)).toFixed(2),
        class: degree % 10 === 0 ? "is-major" : "",
      }, ticks);
      if (degree % 10 !== 0) continue;
      for (const [value, r, cls] of [[degree, R - 23, "is-outer"], [180 - degree, R - 36, "is-inner"]]) {
        const text = svg("text", {
          x: (cos * r).toFixed(2), y: (sin * r).toFixed(2), class: cls,
          // Turned to sit along the rim, the way they are printed on a real one
          transform: `rotate(${90 - degree} ${(cos * r).toFixed(2)} ${(sin * r).toFixed(2)})`,
        }, ticks);
        text.textContent = String(value);
      }
    }

    // The centre: a crosshair, so it can be put exactly on a corner
    svg("line", { class: "ntbk-protractor-cross", x1: -9, y1: 0, x2: 9, y2: 0 }, root);
    svg("line", { class: "ntbk-protractor-cross", x1: 0, y1: -12, x2: 0, y2: 0 }, root);
    svg("line", { class: "ntbk-protractor-guide", x1: 0, y1: 0, x2: 0, y2: -(R - 44) }, root);

    this.armLine = svg("line", { class: "ntbk-protractor-arm", x1: 0, y1: 0 }, root);
    this.armKnob = svg("circle", { class: "ntbk-instrument-knob", "data-grip": "arm" }, root);
    const armTitle = svg("title", {}, this.armKnob);
    armTitle.textContent = "Drag to set the angle. Hold Shift for 15° steps.";

    this.rotateKnob = svg("circle", { class: "ntbk-instrument-knob is-turn",
                                      "data-grip": "rotate", cx: R + 16, cy: 0 }, root);
    svg("title", {}, this.rotateKnob).textContent = "Drag to turn the protractor";

    // The one place it can be picked up by. Everything else lets the pen through.
    this.grip = svg("g", { class: "ntbk-instrument-grip", "data-grip": "move" }, root);
    this.gripBox = svg("rect", { rx: 9, ry: 9 }, this.grip);
    this.gripText = svg("text", {}, this.grip);
    svg("title", {}, this.grip).textContent = "Drag to move the protractor";
  }

  show() {
    // Put back where it was left, unless that is no longer on screen
    if (!this.placed || !inView(this.app, this.x, this.y)) {
      const centre = viewCentre(this.app);
      this.x = centre.x;
      this.y = centre.y + this.radius / 2;
      this.angle = 0;
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
      `translate(${this.x * scale + view.x}px, ${this.y * scale + view.y}px) `
      + `rotate(${this.angle}deg) scale(${scale})`;

    const R = this.radius;
    const a = (this.arm * Math.PI) / 180;
    const reach = R + ARM_REACH;
    const ex = Math.cos(a) * reach, ey = -Math.sin(a) * reach;
    this.armLine.setAttribute("x2", ex.toFixed(2));
    this.armLine.setAttribute("y2", ey.toFixed(2));
    this.armKnob.setAttribute("cx", ex.toFixed(2));
    this.armKnob.setAttribute("cy", ey.toFixed(2));

    // Handles keep their size on screen at any zoom, or they could not be
    // caught when the page is small. Their text stays level however the
    // protractor is turned.
    const k = 1 / scale;
    this.armKnob.setAttribute("r", 9 * k);
    this.rotateKnob.setAttribute("r", 8 * k);
    this.rotateKnob.setAttribute("cx", R + 16 * k);
    const gy = -R * 0.42;
    const label = Number.isInteger(this.arm) ? `${this.arm}°` : `${this.arm.toFixed(1)}°`;
    this.gripText.textContent = `✥ ${label}`;
    this.grip.setAttribute("transform", `translate(0 ${gy}) rotate(${-this.angle}) scale(${k})`);
    Object.entries({ x: -34, y: -12, width: 68, height: 24 })
      .forEach(([key, value]) => this.gripBox.setAttribute(key, value));
  }

  beginSnap() { this._locked = null; }
  endSnap() { this._locked = null; }

  /**
   * Pull a point onto the base, the rim or the arm, whichever is nearest.
   *
   * A stroke stays on the edge it started along. At the centre the base and
   * the arm are the same point, so the choice is only fixed once the pen has
   * moved far enough out for them to be told apart.
   */
  snap(point) {
    if (!this.visible) return point;
    const scale = this.app.scene.scale;
    const R = this.radius;
    const { along, up } = this._local(point);
    const a = (this.arm * Math.PI) / 180;
    const found = [];

    const consider = (name, onAlong, onUp) => {
      const away = Math.hypot(along - onAlong, up - onUp) * scale;
      if (away <= SNAP_DISTANCE) found.push({ name, away, onAlong, onUp });
    };

    // Base: the straight edge through the centre, with a little slack past each end
    if (along > -R - 8 && along < R + 8) consider("base", along, 0);

    // Arm: from the centre out past the rim
    const t = along * Math.cos(a) + up * Math.sin(a);
    if (t > -8 && t < R + ARM_REACH + 8) consider("arm", t * Math.cos(a), t * Math.sin(a));

    // Rim: only the half that exists
    const distance = Math.hypot(along, up);
    if (up > -8 && distance > 1) consider("rim", (along / distance) * R, (up / distance) * R);

    const usable = this._locked ? found.filter((f) => f.name === this._locked) : found;
    if (!usable.length) return point;
    usable.sort((p, q) => p.away - q.away);
    const best = usable[0];
    if (!this._locked && (usable.length === 1 || usable[1].away - best.away > UNDECIDED)) {
      this._locked = best.name;
    }
    const on = this._scene(best.onAlong, best.onUp);
    return { ...point, x: on.x, y: on.y, snapped: true };
  }

  /** Clear plastic: nothing under it is out of the pen's reach. */
  blocks() { return false; }

  destroy() { this.el.remove(); }
}
