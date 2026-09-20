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
    // One gesture can leave several strokes behind: passing under the ruler
    // breaks the line, exactly as a real ruler would.
    this.pieces = [];
    this.kept = [];
  }

  get style() {
    return this.app.settings[this.kind];
  }

  onPointerDown(event, point) {
    if (event.button !== 0) return;
    this.drawing = true;
    this.pieces = [];
    this.kept = [];
    this.raw = [];
    this.liveStroke = null;
    this.app.ruler.beginSnap();
    this._take(point, pressureOf(event));
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
      const raw = sample === event ? point : this.app.scene.toScene(sample.clientX, sample.clientY);
      this._take(raw, pressureOf(sample));
    }

    this._paint();
  }

  /**
   * Accept one sample, unless the ruler is in the way.
   *
   * The edge takes the nib when it is close enough — that is the whole reason
   * to put a ruler on the page. Deeper in, the body blocks it: the line stops
   * at the edge and picks up again where the pen comes out, instead of
   * quietly drawing on the paper underneath.
   */
  _take(point, pressure) {
    const snapped = this.app.ruler.snap(point);
    if (!snapped.snapped && this.app.ruler.blocks(point)) {
      this._breakHere();
      return;
    }
    this.raw.push({ x: snapped.x, y: snapped.y, p: pressure });
  }

  /** End the current piece at the ruler's edge and wait for the pen to reappear. */
  _breakHere() {
    if (this.raw.length >= 2) {
      const thinned = this._thin();
      this.pieces.push(thinned);
      // Leave the finished piece on screen so the line does not flicker away
      // while the pen is still travelling under the ruler
      if (this.liveStroke) this.kept.push(this.liveStroke);
    } else if (this.liveStroke) {
      this.app.scene.ink.remove(this.liveStroke.id);
    }
    this.raw = [];
    this.liveStroke = null;
  }

  _paint() {
    if (!this.raw.length) return;
    if (!this.liveStroke) {
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
    } else {
      this.liveStroke.points = flatten(this._thin());
    }
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
    this.app.ruler.endSnap();

    // Whatever is still in hand becomes the last piece
    if (this.raw.length === 1) {
      // A tap still deserves a dot
      this.raw.push({ ...this.raw[0], x: this.raw[0].x + 0.01 });
    }
    if (this.raw.length >= 2) {
      this.pieces.push(this._thin());
      if (this.liveStroke) this.kept.push(this.liveStroke);
    }

    for (const preview of this.kept) this.app.scene.ink.remove(preview.id);
    if (this.liveStroke) this.app.scene.ink.remove(this.liveStroke.id);
    this.liveStroke = null;
    this.kept = [];

    const strokes = this.pieces.map((points) => this.app.adopt(createStroke({
      kind: this.kind,
      points: flatten(points),
      style: { ...this.style },
    })));

    // One gesture, one undo step, however many pieces the ruler cut it into
    if (strokes.length) {
      this.app.history.run(
        addElements(strokes, this.kind === "pen" ? "Draw" : "Highlight"));
    }
    this.pieces = [];
    this.raw = [];
  }

  onCancel() {
    this.app.ruler.endSnap();
    for (const preview of this.kept) this.app.scene.ink.remove(preview.id);
    if (this.liveStroke) this.app.scene.ink.remove(this.liveStroke.id);
    this.drawing = false;
    this.liveStroke = null;
    this.kept = [];
    this.pieces = [];
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
