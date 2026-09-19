import simplify from "simplify-js";
import { createStroke } from "../model/document.js";
import { addElements } from "../model/history.js";

// ─────────────────────────────────────────────
//  PEN / HIGHLIGHTER
//
//  Same tool, different style. The highlighter
//  is a marker: constant width, multiply blend,
//  and it renders beneath the ink.
// ─────────────────────────────────────────────
// Douglas-Peucker tolerance in scene units. At 0.4 the thinned line stays
// within 0.4px of every sample it dropped, which is invisible — but it has to
// be applied to the PREVIEW as well as the commit, see _thin() below.
const SIMPLIFY_TOLERANCE = 0.4;

export class PenTool {
  constructor(app, kind = "pen") {
    this.app = app;
    this.kind = kind;
    this.cursor = "crosshair";
    this.drawing = false;
    this.raw = [];      // {x, y, p} — simplify-js reads x/y and returns the
                        // same objects back, so pressure survives thinning
    this.liveStroke = null;
  }

  get style() {
    return this.app.settings[this.kind];
  }

  onPointerDown(event, point) {
    if (event.button !== 0) return;
    this.drawing = true;
    this.raw = [{ x: point.x, y: point.y, p: pressureOf(event) }];

    this.liveStroke = createStroke({
      kind: this.kind,
      points: flatten(this.raw),
      style: { ...this.style },
    });
    // Deliberately NOT setting done=false. perfect-freehand's `last` flag
    // changes how the stroke end is built, so previewing with it off and
    // committing with it on makes the ink visibly shift the moment you lift
    // the pen. Rendering both the same way is what makes what you see the
    // thing you keep.
    this.app.scene.ink.render(this.liveStroke);
  }

  onPointerMove(event, point) {
    if (!this.drawing) return;

    // Coalesced events give every sample the OS captured between frames,
    // which is what keeps fast strokes smooth instead of polygonal.
    // It can come back empty (untrusted events, some browsers) — falling
    // through to the event itself is what stops a stroke losing its middle.
    const coalesced = event.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length ? coalesced : [event];
    for (const sample of samples) {
      const p = sample === event ? point : this.app.scene.toScene(sample.clientX, sample.clientY);
      this.raw.push({ x: p.x, y: p.y, p: pressureOf(sample) });
    }

    this.liveStroke.points = flatten(this._thin());
    this.app.scene.ink.render(this.liveStroke);
  }

  /**
   * Thin the sample list the same way for the preview and for the commit.
   *
   * This is the whole trick. perfect-freehand's streamline smoothing works on
   * the point *sequence*, not on distance, so the same path drawn with dense
   * samples and with thinned samples comes out as visibly different curves.
   * Previewing raw points and then storing thinned ones therefore made the
   * ink change shape the moment you lifted the pen. Thinning both means what
   * you see while writing is exactly what gets kept.
   */
  _thin() {
    return simplify(this.raw, SIMPLIFY_TOLERANCE, true);
  }

  onPointerUp() {
    if (!this.drawing) return;
    this.drawing = false;

    const live = this.liveStroke;
    this.liveStroke = null;
    this.app.scene.ink.remove(live.id);

    if (this.raw.length < 2) {
      // A tap still deserves a dot
      this.raw.push({ ...this.raw[0], x: this.raw[0].x + 0.01 });
    }

    // Same thinning the preview was already drawing from
    const thinned = this._thin();

    const stroke = createStroke({
      kind: this.kind,
      points: flatten(thinned),
      style: { ...this.style },
    });
    this.app.history.run(addElements([stroke], this.kind === "pen" ? "Draw" : "Highlight"));
    this.raw = [];
  }

  onCancel() {
    if (this.liveStroke) this.app.scene.ink.remove(this.liveStroke.id);
    this.drawing = false;
    this.liveStroke = null;
    this.raw = [];
  }
}

function flatten(points) {
  const out = new Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i].x;
    out[i * 3 + 1] = points[i].y;
    out[i * 3 + 2] = points[i].p;
  }
  return out;
}

function pressureOf(event) {
  // A mouse reports 0.5 while held, or 0 in some browsers. Pen reports real
  // pressure. Treat anything falsy as a mid-weight press.
  if (event.pointerType === "pen" && event.pressure > 0) return event.pressure;
  return 0.5;
}
