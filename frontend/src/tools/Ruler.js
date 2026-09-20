import { PX_PER_MM } from "../model/document.js";

// ─────────────────────────────────────────────
//  RULER
//
//  A real instrument, not content: it is never
//  saved in the document and it vanishes when
//  you put it away.
//
//  Its whole point is the edge — ink drawn near
//  it snaps to the line, which is what makes a
//  straight line straight.
// ─────────────────────────────────────────────
const PX_PER_CM = PX_PER_MM * 10;

/** How close the pen has to be, in screen pixels, before the edge takes it. */
const SNAP_DISTANCE = 26;

export class Ruler {
  constructor(app) {
    this.app = app;
    this.lengthCm = 30;
    // Scene coordinates of the ruler's centre, plus its angle in degrees.
    // 0 is horizontal and angles grow clockwise, which is what the protractor
    // reads out.
    this.x = 0;
    this.y = 0;
    this.angle = 0;
    this.visible = false;

    this.el = document.createElement("div");
    this.el.className = "ntbk-ruler";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="ntbk-ruler-body">
        <div class="ntbk-ruler-ticks"></div>
        <div class="ntbk-ruler-protractor">
          <svg viewBox="-60 -60 120 120" class="ntbk-ruler-dial"></svg>
          <div class="ntbk-ruler-readout">0°</div>
        </div>
        <div class="ntbk-ruler-grip" data-grip="move" title="Drag to move"></div>
        <div class="ntbk-ruler-rotate" data-grip="rotate" title="Drag to rotate"></div>
      </div>`;

    this.body = this.el.querySelector(".ntbk-ruler-body");
    this.readout = this.el.querySelector(".ntbk-ruler-readout");
    this._buildTicks();
    this._buildDial();
    this._wire();

    app.host.appendChild(this.el);
    app.host.addEventListener("scene:transform", () => this.place());
  }

  /**
   * Centimetre and millimetre marks on BOTH long edges, numbered every cm.
   *
   * Both edges draw, so both are marked — a ruler with markings on one side
   * would be telling you only half the truth about where you can rule.
   */
  _buildTicks() {
    const ticks = this.el.querySelector(".ntbk-ruler-ticks");
    ticks.innerHTML = "";
    for (const side of ["bottom", "top"]) {
      for (let mm = 0; mm <= this.lengthCm * 10; mm++) {
        const tick = document.createElement("div");
        const isCm = mm % 10 === 0;
        const isHalf = mm % 5 === 0;
        tick.className = `ntbk-ruler-tick is-${side}`
          + (isCm ? " is-cm" : isHalf ? " is-half" : "");
        tick.style.left = `${mm * PX_PER_MM}px`;
        if (isCm) {
          const label = document.createElement("span");
          label.textContent = String(mm / 10);
          tick.appendChild(label);
        }
        ticks.appendChild(tick);
      }
    }
  }

  /** The protractor face: a half-circle of degree marks every 10°. */
  _buildDial() {
    const svg = this.el.querySelector(".ntbk-ruler-dial");
    const ns = "http://www.w3.org/2000/svg";
    for (let deg = 0; deg < 360; deg += 10) {
      const major = deg % 30 === 0;
      const a = (deg * Math.PI) / 180;
      const r1 = major ? 38 : 43;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", (Math.cos(a) * r1).toFixed(1));
      line.setAttribute("y1", (Math.sin(a) * r1).toFixed(1));
      line.setAttribute("x2", (Math.cos(a) * 48).toFixed(1));
      line.setAttribute("y2", (Math.sin(a) * 48).toFixed(1));
      line.setAttribute("class", major ? "is-major" : "");
      svg.appendChild(line);
      if (major) {
        const text = document.createElementNS(ns, "text");
        text.setAttribute("x", (Math.cos(a) * 28).toFixed(1));
        text.setAttribute("y", (Math.sin(a) * 28 + 3).toFixed(1));
        text.textContent = String(deg);
        svg.appendChild(text);
      }
    }
  }

  _wire() {
    // The ruler must never be drawn on or selected through
    for (const type of ["pointerdown", "pointermove", "pointerup", "dblclick"]) {
      this.el.addEventListener(type, (event) => event.stopPropagation());
    }

    let drag = null;
    this.el.addEventListener("pointerdown", (event) => {
      const grip = event.target.closest("[data-grip]")?.dataset.grip;
      if (!grip) return;
      event.preventDefault();
      this.el.setPointerCapture(event.pointerId);
      const point = this.app.scene.toScene(event.clientX, event.clientY);
      drag = { grip, startX: point.x, startY: point.y,
               originX: this.x, originY: this.y, originAngle: this.angle };
    });

    this.el.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const point = this.app.scene.toScene(event.clientX, event.clientY);
      if (drag.grip === "move") {
        this.x = drag.originX + (point.x - drag.startX);
        this.y = drag.originY + (point.y - drag.startY);
      } else {
        // Angle from the ruler's centre to the pointer
        const degrees = (Math.atan2(point.y - this.y, point.x - this.x) * 180) / Math.PI;
        // Shift locks to 15° steps, for the constructions that need exact angles
        this.angle = event.shiftKey ? Math.round(degrees / 15) * 15 : degrees;
      }
      this.place();
    });

    const end = (event) => {
      if (!drag) return;
      drag = null;
      try { this.el.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
  }

  show() {
    if (!this.visible) {
      // Park it across the middle of what you are looking at
      const rect = this.app.host.getBoundingClientRect();
      const centre = this.app.scene.toScene(
        rect.left + rect.width / 2, rect.top + rect.height / 2);
      this.x = centre.x;
      this.y = centre.y;
      this.angle = 0;
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

  /** Normalised 0–360 reading, the way the protractor shows it. */
  get reading() {
    return ((this.angle % 360) + 360) % 360;
  }

  place() {
    if (!this.visible) return;
    const scale = this.app.scene.scale;
    const lengthPx = this.lengthCm * PX_PER_CM;
    const left = this.x - lengthPx / 2;

    this.body.style.width = `${lengthPx}px`;
    // Positioned in viewport pixels so the ruler stays a constant thickness
    // on screen while its LENGTH scales with the page — a 30cm ruler has to
    // stay 30cm against the paper, whatever the zoom.
    const view = this.app.scene.view;
    this.el.style.left = `${left * scale + view.x}px`;
    this.el.style.top = `${this.y * scale + view.y}px`;
    this.el.style.width = `${lengthPx * scale}px`;
    this.el.style.transform = `rotate(${this.angle}deg)`;
    this.body.style.transform = `scale(${scale})`;
    this.body.style.transformOrigin = "0 0";
    this.readout.textContent = `${Math.round(this.reading)}°`;
    this.readout.style.transform = `rotate(${-this.angle}deg)`;
  }

  /**
   * Both drawing edges, in scene coordinates.
   *
   * A real ruler rules against either long side, so both are live. The ruler
   * rotates about its top-centre, (x, y), and straight down the ruler —
   * local (0, 1) — lands on (-sin, cos); the far edge is that point pushed
   * one body-height along it.
   */
  edges() {
    const radians = (this.angle * Math.PI) / 180;
    const half = (this.lengthCm * PX_PER_CM) / 2;
    const dx = Math.cos(radians);
    const dy = Math.sin(radians);
    const nx = -dy;
    const ny = dx;

    const lineAt = (offset, side) => {
      const cx = this.x + nx * offset;
      const cy = this.y + ny * offset;
      return {
        side,
        x1: cx - dx * half, y1: cy - dy * half,
        x2: cx + dx * half, y2: cy + dy * half,
        dx, dy,
      };
    };
    return [lineAt(0, "top"), lineAt(RULER_HEIGHT_PX, "bottom")];
  }

  /** The far edge, kept for anything that only wants one. */
  edge() {
    return this.edges()[1];
  }

  /** A stroke picks one edge on its first snap and keeps it to the end. */
  beginSnap() {
    this._locked = null;
  }

  endSnap() {
    this._locked = null;
  }

  /**
   * Pull a point onto the edge if it is close enough.
   *
   * Returns the point unchanged when the ruler is away or the pen is far
   * from it, so the caller can hand every sample through this blindly.
   */
  /**
   * Is this point underneath the ruler?
   *
   * A real ruler is a physical object: the nib cannot reach the paper beneath
   * it, so no ink appears there. Anything deeper than the snap zone on either
   * side is under the body and must not mark the page.
   */
  blocks(point) {
    if (!this.visible) return false;
    const [top] = this.edges();
    const length = this.lengthCm * PX_PER_CM;

    const along = (point.x - top.x1) * top.dx + (point.y - top.y1) * top.dy;
    if (along < 0 || along > length) return false;

    // Distance across the ruler, 0 at the near edge and one body-height at
    // the far one
    const across = (point.x - top.x1) * -top.dy + (point.y - top.y1) * top.dx;
    return across > 0 && across < RULER_HEIGHT_PX;
  }

  snap(point) {
    if (!this.visible) return point;
    const scale = this.app.scene.scale;
    const length = this.lengthCm * PX_PER_CM;

    // Once a stroke has committed to an edge it stays there. Without this a
    // line drawn along one side could jump to the other halfway through.
    const candidates = this._locked
      ? this.edges().filter((line) => line.side === this._locked)
      : this.edges();

    let best = null;
    for (const line of candidates) {
      const along = (point.x - line.x1) * line.dx + (point.y - line.y1) * line.dy;
      // A little slack past each end, so a line doesn't break at the very tip
      if (along < -8 || along > length + 8) continue;
      const onLine = { x: line.x1 + line.dx * along, y: line.y1 + line.dy * along };
      // Distance is judged on screen, so the feel is the same at any zoom
      const away = Math.hypot(point.x - onLine.x, point.y - onLine.y) * scale;
      if (away > SNAP_DISTANCE) continue;
      if (!best || away < best.away) best = { away, onLine, side: line.side };
    }

    if (!best) return point;
    this._locked = best.side;
    return { ...point, x: best.onLine.x, y: best.onLine.y, snapped: true };
  }

  destroy() {
    this.el.remove();
  }
}

// Matches .ntbk-ruler-body height in the stylesheet
const RULER_HEIGHT_PX = 74;
