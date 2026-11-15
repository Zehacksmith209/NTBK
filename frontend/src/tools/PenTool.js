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

// Longest gap, in scene units, we will leave between two stored samples.
// This exists purely to protect the smoother from the simplifier — see
// respace() at the bottom of this file for why that is needed at all.
const MAX_SAMPLE_GAP = 2.5;

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
    // Set the moment a sample arrives carrying real stylus pressure — see
    // _style() for what it decides.
    this.realPressure = false;
  }

  /**
   * The style this gesture should be committed with.
   *
   * perfect-freehand only consults the pressure we supply when
   * `simulatePressure` is false; with it true it discards those values and
   * re-derives pressure from velocity instead. Its default is true, so a
   * graphics tablet reporting real pressure was having it thrown away and
   * replaced with a guess made from how fast the nib was moving.
   *
   * So: trust the hardware when the hardware said something. A mouse only
   * ever reports a flat 0.5, and honouring that would give a dead uniform
   * line, so there we do want the velocity simulation.
   */
  _style() {
    return { ...this.style, simulatePressure: !this.realPressure };
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
    this.realPressure = false;
    this.app.instruments.beginSnap();
    if (hasRealPressure(event)) this.realPressure = true;
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
      if (hasRealPressure(sample)) this.realPressure = true;
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
    const snapped = this.app.instruments.snap(point);
    if (!snapped.snapped && this.app.instruments.blocks(point)) {
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
        style: this._style(),
      });
      // Deliberately NOT setting done=false. perfect-freehand's `last` flag
      // changes how the stroke end is built, so previewing with it off and
      // committing with it on makes the ink visibly shift the moment you lift
      // the pen. Rendering both the same way is what makes what you see the
      // thing you keep.
    } else {
      this.liveStroke.points = flatten(this._thin());
      // The first sample of a tablet stroke can land before the pen is
      // properly down and report zero, so re-read it rather than trusting
      // whatever was true when the preview was created.
      this.liveStroke.style = this._style();
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
    return respace(simplify(this.raw, SIMPLIFY_TOLERANCE, true));
  }

  onPointerUp() {
    if (!this.drawing) return;
    this.drawing = false;
    this.app.instruments.endSnap();

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
      style: this._style(),
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
    this.app.instruments.endSnap();
    for (const preview of this.kept) this.app.scene.ink.remove(preview.id);
    if (this.liveStroke) this.app.scene.ink.remove(this.liveStroke.id);
    this.drawing = false;
    this.liveStroke = null;
    this.kept = [];
    this.pieces = [];
    this.raw = [];
  }
}

/**
 * Put samples back along the thinned line so no two are far apart.
 *
 * Douglas-Peucker measures DISTANCE, perfect-freehand's streamline counts
 * SAMPLES: it moves each point only part of the way toward the next one, so
 * its lag is however far apart those two points happen to be. Thinning a
 * straight pen stroke down to its two endpoints therefore asks the smoother
 * to cross the whole stroke in one step, and it never arrives — the corner
 * gets shaved off and the letter comes out as a shape you did not write.
 * Measured on a 26-unit "w": corners cut by 7.3 units, over a quarter of the
 * letter. Neither filter does that alone; only the two together.
 *
 * The straighter and more confident the writing, the harder Douglas-Peucker
 * compresses it, and the worse the distortion — which is exactly backwards.
 *
 * So: thin for noise, then walk the result and drop a sample every
 * MAX_SAMPLE_GAP units. The line does not move (the inserted points sit on
 * it), the jitter stays gone, and streamline gets the fine spacing it
 * assumes. Same 26-unit "w": 7.3 units of corner loss becomes 0.9, and the
 * stroke still stores fewer points than came in raw.
 *
 * Applied inside _thin(), so the preview and the committed stroke go on
 * getting the identical treatment.
 */
function respace(points) {
  if (points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const gap = Math.hypot(b.x - a.x, b.y - a.y);
    if (gap > MAX_SAMPLE_GAP) {
      const steps = Math.ceil(gap / MAX_SAMPLE_GAP);
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        out.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          // Pressure is interpolated too, or the fill would step in bands
          p: a.p + (b.p - a.p) * t,
        });
      }
    }
    out.push(b);
  }
  return out;
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

/** Did this sample come from hardware that actually measures pressure? */
function hasRealPressure(event) {
  return event.pointerType === "pen" && event.pressure > 0 && event.pressure !== 0.5;
}

function pressureOf(event) {
  // A mouse reports 0.5 while held, or 0 in some browsers. Pen reports real
  // pressure. Treat anything falsy as a mid-weight press.
  if (event.pointerType === "pen" && event.pressure > 0) return event.pressure;
  return 0.5;
}
