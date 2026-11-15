import JXG from "jsxgraph";
import "../styles/jsxgraph.css";
import { compile } from "mathjs";

// ─────────────────────────────────────────────
//  GRAPH RENDERER
//
//  Turns a plot spec into an SVG image.
//
//  Only the spec is saved in a .ntbk, never the
//  rendered SVG. Two reasons: notebooks stay
//  small, and an SVG arriving inside a shared
//  file is untrusted markup we would otherwise
//  be injecting into the page.
// ─────────────────────────────────────────────
export const DEFAULT_COLORS =
  ["#1a6ef5", "#c62828", "#2e7d32", "#f57c00", "#6a1b9a", "#00838f"];

// Camera angles, named by what you SEE rather than by which axis they turn
// about — "rotate around the vertical axis" and "get the side views" are the
// same motion, and naming by outcome avoids that confusion entirely.
//   az   (turn) sweeps around the sides
//   el   (tilt) raises and lowers the viewpoint
//   bank (roll) spins the picture inside its frame
export const VIEW_PRESETS = {
  isometric: { az: Math.PI / 4, el: 0.62, bank: 0 },
  top:       { az: Math.PI / 4, el: Math.PI / 2 - 0.01, bank: 0 },
  bottom:    { az: Math.PI / 4, el: -Math.PI / 2 + 0.01, bank: 0 },
  front:     { az: Math.PI / 2, el: 0, bank: 0 },
  side:      { az: 0, el: 0, bank: 0 },
};

export function createGraphSpec(kind = "function2d") {
  if (kind === "surface3d") {
    return {
      engine: "jsxgraph", kind,
      surfaces: [{ expr: "sin(x)*cos(y)", color: DEFAULT_COLORS[0] }],
      xRange: [-5, 5], yRange: [-5, 5], zRange: [-3, 3],
      // "wireframe" draws the quad edges; "shaded" fills the faces. JSXGraph
      // treats this as immutable once the element exists, so changing it
      // rebuilds the board rather than setting an attribute.
      shading: "wireframe",
      // Turn, tilt and roll, in radians. Stored so the view you chose is the
      // view that comes back when you reopen the file.
      view: { ...VIEW_PRESETS.isometric },
    };
  }
  if (kind === "stats") {
    return {
      engine: "jsxgraph", kind,
      data: [4, 7, 2, 9, 5, 6, 3, 8, 5, 4],
      chartType: "bar",
      color: DEFAULT_COLORS[0],
    };
  }
  return {
    engine: "jsxgraph", kind: "function2d",
    functions: [{ expr: "x^2", color: DEFAULT_COLORS[0] }],
    bounds: [-8, 6, 8, -6],      // xmin, ymax, xmax, ymin — JSXGraph's order
    axes: true,
    grid: true,
  };
}

/**
 * The JSXGraph attribute for a spec's shading mode.
 *
 * The attribute is `type`, NOT `tiling` — the documentation says tiling and
 * the code reads type, and passing tiling silently does nothing. Verified
 * against 1.13.3: `type: 'shader'` builds the filled polyhedron, `tiling`
 * leaves the wireframe untouched.
 */
export function surfaceType(spec) {
  return spec?.shading === "shaded" ? "shader" : "wireframe";
}

/**
 * The surfaces in a 3D spec.
 * Older documents stored a single `expr`; read them as a one-item list so
 * a file saved before multi-surface support still opens.
 */
// Sampling for the implicit solver. Coarse enough to stay interactive, fine
// enough that a sphere's equator does not go lumpy.
const SOLVE_STEPS = 44;     // z samples per (x, y) when hunting for sign changes
const BISECT_STEPS = 26;    // halvings once a root is bracketed
const MAX_SHEETS = 4;       // beyond this it is a mesh, not a graph
const CURVE_STEPS = 96;     // rays traced when extruding a 2D curve
const IMPLICIT_STEPS = 22;  // mesh density for a solved sheet, kept coarse

// ── Navigating the plotted region ────────────
//
// Zoom and pan act on the RANGES rather than on a camera. Same mental model
// in 2D and 3D, it is saved with the document, and it works on the inert
// board drawn on the canvas — not only inside the interactive editor.

/** The span a plot opens at, used as the 1x reference for the zoom readout. */
export const DEFAULT_SPAN = { x2d: 16, x3d: 10 };

/** Scale a [min, max] pair about its own centre. Bigger factor = zoomed in. */
function scaleRange([min, max], factor) {
  const centre = (min + max) / 2;
  const half = ((max - min) / 2) / factor;
  return [centre - half, centre + half];
}

function shiftRange([min, max], fraction) {
  const step = (max - min) * fraction;
  return [min + step, max + step];
}

/** bounds is JSXGraph's order: [xmin, ymax, xmax, ymin]. */
export function zoomBounds(bounds, factor) {
  const [x0, x1] = scaleRange([bounds[0], bounds[2]], factor);
  const [y0, y1] = scaleRange([bounds[3], bounds[1]], factor);
  return [x0, y1, x1, y0];
}

export function panBounds(bounds, dx, dy) {
  const [x0, x1] = shiftRange([bounds[0], bounds[2]], dx);
  const [y0, y1] = shiftRange([bounds[3], bounds[1]], dy);
  return [x0, y1, x1, y0];
}

/** How far in we currently are, against the span a plot opens at. */
export function zoomOf(spanNow, reference) {
  return spanNow > 0 ? reference / spanNow : 1;
}

export function surfacesOf(spec) {
  if (Array.isArray(spec.surfaces)) return spec.surfaces;
  if (spec.expr) return [{ expr: spec.expr, color: spec.color ?? DEFAULT_COLORS[0] }];
  return [];
}

/** Compile z = f(x, y). Returns null if it doesn't parse. */
export function compileSurface(expr) {
  try {
    const code = compile(expr);
    const f = (x, y) => {
      const value = code.evaluate({ x, y });
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    f(0, 0);
    return f;
  } catch {
    return null;
  }
}

/** "1, 2 3\n4" -> [1,2,3,4]. Forgiving about how people paste numbers. */
export function parseData(text) {
  return String(text)
    .split(/[\s,;]+/)
    .map((piece) => Number(piece))
    .filter((value) => Number.isFinite(value));
}

/** Compile an expression to f(x). Returns null if it doesn't parse. */
/**
 * Is this an equation rather than a formula for y?
 *
 * "9x^2 + 4y^2 = 36" is a relation between x and y — an ellipse, which fails
 * the vertical line test and so can never be a function of x. Spotting the
 * "=" is what lets one box accept both. Comparison operators are excluded so
 * "x >= 2" is not mistaken for one.
 */
export function isEquation(expr) {
  return /[^<>=!]=[^=]/.test(String(expr));
}

/** F(x, y) for an implicit curve: everything moved to one side of the "=". */
export function compileImplicit(expr) {
  try {
    const parts = String(expr).split("=");
    if (parts.length !== 2) return null;
    const left = compile(parts[0]);
    const right = compile(parts[1]);
    const f = (x, y) => {
      const a = left.evaluate({ x, y });
      const b = right.evaluate({ x, y });
      if (typeof a !== "number" || typeof b !== "number") return NaN;
      return a - b;
    };
    f(0, 0);      // fail fast on nonsense
    return f;
  } catch {
    return null;
  }
}

/** Whichever of the two a 2D entry needs, decided by what was typed. */
export function compile2d(expr) {
  return isEquation(expr) ? compileImplicit(expr) : compileExpression(expr);
}

/**
 * Whichever a 3D entry needs. An equation is checked as a relation in
 * x, y and z; a plain expression as a function of x and y.
 */
export function compile3d(expr) {
  return isEquation(expr) ? compileImplicit3d(expr) : compileSurface(expr);
}

export function compileExpression(expr) {
  try {
    const code = compile(expr);
    const f = (x) => {
      const value = code.evaluate({ x });
      return typeof value === "number" && Number.isFinite(value) ? value : NaN;
    };
    f(0);   // fail fast on nonsense like "x +"
    return f;
  } catch {
    return null;
  }
}

/**
 * Build a JSXGraph board into `container` from a spec.
 * Used for both the live editor board and the offscreen render.
 */
export function buildBoard(container, spec, { interactive = false } = {}) {
  if (spec.kind === "surface3d") return buildSurfaceBoard(container, spec, interactive);
  if (spec.kind === "stats") return buildStatsBoard(container, spec, interactive);

  const board = JXG.JSXGraph.initBoard(container, {
    boundingbox: spec.bounds,
    axis: spec.axes !== false,
    grid: spec.grid !== false,
    showCopyright: false,
    showNavigation: false,
    keepaspectratio: false,
    pan: { enabled: interactive, needTwoFingers: false },
    zoom: { enabled: interactive, wheel: interactive },
    defaultAxes: {
      x: { ticks: { majorHeight: 8, minorTicks: 1 } },
      y: { ticks: { majorHeight: 8, minorTicks: 1 } },
    },
  });

  board.suspendUpdate();
  for (const item of spec.functions) {
    if (item.visible === false) continue;
    const style = {
      strokeColor: item.color,
      strokeWidth: 2,
      highlight: false,
      fixed: true,
      // Adaptive plotting subdivides until a curve looks smooth. That is
      // right for sin(x) and ruinous for sin(e^x), which by x = 8 completes
      // ~475 oscillations per unit: the plotter keeps splitting to resolve
      // detail far below a pixel, and one rebuild costs 115ms instead of 24.
      //
      // Turning adaptivity OFF is the wrong fix — measured, it made the four
      // ordinary functions in that same plot go 24ms -> 82ms, because a fixed
      // sample count denies them the shortcut they were getting. Capping the
      // DEPTH instead leaves well-behaved curves untouched (they never
      // recurse that far) and only stops the runaway case.
      recursionDepthHigh: 12,
    };
    // An equation is a relation, not a function, so it needs the implicit
    // plotter — that is what draws a whole conic instead of half of one
    if (isEquation(item.expr)) {
      const f = compileImplicit(item.expr);
      if (f) board.create("implicitcurve", [f], style);
      continue;
    }
    const f = compileExpression(item.expr);
    if (f) board.create("functiongraph", [f], style);
  }
  board.unsuspendUpdate();
  return board;
}

/**
 * Point the camera.
 *
 * NOT view.setView(az, el, bank) — its third argument is the camera
 * DISTANCE, so passing a roll angle there zooms the plot instead of
 * rotating it. Roll lives on its own slider.
 */
export function applyView3D(view, angles) {
  if (!view || !angles) return;
  view.setView(angles.az, angles.el);
  if (view.bank_slide) view.bank_slide.setValue(angles.bank ?? 0);
  view.board.update();
}

/** z = f(x, y) on a rotatable 3D view. */
/** Does this expression mention z at all? A surface that doesn't is a wall. */
export function mentionsZ(expr) {
  return /\bz\b/.test(String(expr));
}

/**
 * F(x, y, z) for an implicit surface: everything moved to one side of the "=".
 */
export function compileImplicit3d(equation) {
  try {
    const parts = String(equation).split("=");
    if (parts.length !== 2) return null;
    const left = compile(parts[0]);
    const right = compile(parts[1]);
    const f = (x, y, z) => {
      const a = left.evaluate({ x, y, z });
      const b = right.evaluate({ x, y, z });
      if (typeof a !== "number" || typeof b !== "number") return NaN;
      return a - b;
    };
    f(0, 0, 0);     // fail fast on nonsense
    return f;
  } catch {
    return null;
  }
}

/**
 * Every z where F(x, y, ·) crosses zero, found by scanning then bisecting.
 *
 * This is what turns an implicit surface into something JSXGraph can draw:
 * it has no implicit-surface element, but it will happily draw any
 * (x, y) -> z, and each root is one such function. A sphere is two of them.
 */
export function rootsInZ(F, x, y, zMin, zMax, steps = SOLVE_STEPS) {
  const roots = [];
  let previousZ = zMin;
  let previousF = F(x, y, previousZ);

  for (let i = 1; i <= steps; i++) {
    const z = zMin + ((zMax - zMin) * i) / steps;
    const value = F(x, y, z);
    // A sign change brackets a root. Equal signs cannot, and a NaN means the
    // function has no opinion here, so neither can be bisected.
    if (Number.isFinite(previousF) && Number.isFinite(value) && previousF * value < 0) {
      let low = previousZ;
      let high = z;
      let lowValue = previousF;
      for (let k = 0; k < BISECT_STEPS; k++) {
        const middle = (low + high) / 2;
        const middleValue = F(x, y, middle);
        if (lowValue * middleValue <= 0) {
          high = middle;
        } else {
          low = middle;
          lowValue = middleValue;
        }
      }
      roots.push((low + high) / 2);
    }
    previousZ = z;
    previousF = value;
  }
  return roots;
}

/** How many sheets this surface needs, sampled coarsely across the box. */
function sheetCount(F, xRange, yRange, zRange) {
  let most = 0;
  for (let i = 0; i <= 16; i++) {
    for (let j = 0; j <= 16; j++) {
      const x = xRange[0] + ((xRange[1] - xRange[0]) * i) / 16;
      const y = yRange[0] + ((yRange[1] - yRange[0]) * j) / 16;
      most = Math.max(most, rootsInZ(F, x, y, zRange[0], zRange[1], 24).length);
      if (most >= MAX_SHEETS) return MAX_SHEETS;
    }
  }
  return most;
}

/**
 * Draw an equation with no z in it: a 2D curve swept along the z axis.
 *
 * "Solve for z" is the wrong question for a vertical wall — on the curve
 * EVERY z works, off it none does, so nothing ever crosses zero. The curve is
 * traced in the xy-plane instead and extruded, which is what a cylinder
 * actually is.
 */
function extrudeCurve(view, equation, colour, spec) {
  const F = compileImplicit3d(equation);
  if (!F) return false;

  const [xMin, xMax] = spec.xRange;
  const [yMin, yMax] = spec.yRange;
  // March a ray out from the centre in every direction and find where the
  // curve crosses it. Good enough for the closed curves this is ever used on.
  const centreX = (xMin + xMax) / 2;
  const centreY = (yMin + yMax) / 2;
  const reach = Math.hypot(xMax - xMin, yMax - yMin) / 2;

  const points = [];
  for (let i = 0; i <= CURVE_STEPS; i++) {
    const angle = (2 * Math.PI * i) / CURVE_STEPS;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let previousR = 0;
    let previousF = F(centreX, centreY, 0);
    let hit = null;
    for (let k = 1; k <= 160; k++) {
      const r = (reach * k) / 160;
      const value = F(centreX + dx * r, centreY + dy * r, 0);
      if (Number.isFinite(previousF) && Number.isFinite(value) && previousF * value < 0) {
        let low = previousR;
        let high = r;
        let lowValue = previousF;
        for (let b = 0; b < BISECT_STEPS; b++) {
          const middle = (low + high) / 2;
          const middleValue = F(centreX + dx * middle, centreY + dy * middle, 0);
          if (lowValue * middleValue <= 0) {
            high = middle;
          } else {
            low = middle;
            lowValue = middleValue;
          }
        }
        hit = (low + high) / 2;
        break;
      }
      previousR = r;
      previousF = value;
    }
    points.push(hit === null ? null : [centreX + dx * hit, centreY + dy * hit]);
  }
  if (!points.some(Boolean)) return false;

  const at = (t) => {
    const index = Math.min(points.length - 1, Math.max(0, Math.round(t)));
    return points[index] ?? points.find(Boolean);
  };
  view.create("parametricsurface3d", [
    (t, s) => at(t)[0],
    (t, s) => at(t)[1],
    (t, s) => s,
    [0, CURVE_STEPS],
    spec.zRange,
  ], {
    strokeColor: colour, strokeWidth: 0.5, strokeOpacity: 0.6,
    fillColor: colour, fillOpacity: 0.55,
    stepsU: CURVE_STEPS, stepsV: 2, highlight: false,
  });
  return true;
}

function buildSurfaceBoard(container, spec, interactive) {
  const board = JXG.JSXGraph.initBoard(container, {
    boundingbox: [-8, 8, 8, -8],
    axis: false,
    grid: false,
    showCopyright: false,
    showNavigation: false,
    keepaspectratio: true,
    pan: { enabled: false },
    zoom: { enabled: false },
  });

  const view = board.create("view3D", [
    [-6, -4], [11, 11],
    [spec.xRange, spec.yRange, spec.zRange],
  ], {
    projection: "central",
    depthOrder: { enabled: true },
    // JSXGraph's own angle sliders are suppressed in favour of ours in the
    // editor panel. Trackball dragging is off with them: reading the angles
    // back out needs those sliders to exist, so a drag would silently put
    // the drawing out of step with the saved spec.
    trackball: { enabled: false },
    az: { slider: { visible: false }, pointer: { enabled: false } },
    // The internal sliders are what actually hold the angles, and their
    // default range is 0..2pi. Tilt would clamp at 0 — no view from below —
    // so the range is widened here rather than fought with later.
    el: {
      slider: { visible: false, min: -Math.PI / 2, max: Math.PI / 2 },
      pointer: { enabled: false },
    },
    bank: {
      slider: { visible: false, min: -Math.PI, max: Math.PI },
      pointer: { enabled: false },
    },
  });

  applyView3D(view, spec.view ?? VIEW_PRESETS.isometric);
  // Handed to the editor so a slider can move the camera without rebuilding
  board.ntbkView3D = view;

  // Fewer mesh lines each when several surfaces share a box, or they turn
  // into an unreadable tangle
  const list = surfacesOf(spec);
  const steps = list.length > 2 ? 20 : 28;

  for (const item of list) {
    if (item.visible === false) continue;

    // An equation is a relation, not a function of x and y, so it cannot be
    // drawn directly — it is solved for z first, or extruded.
    if (isEquation(item.expr)) {
      drawImplicitSurface(view, item, spec, steps);
      continue;
    }

    const f = compileSurface(item.expr);
    if (!f) continue;
    view.create("functiongraph3d", [f, spec.xRange, spec.yRange], {
      type: surfaceType(spec),
      strokeColor: item.color,
      strokeWidth: 0.6,
      stepsU: steps,
      stepsV: steps,
      highlight: false,
      // Only read when type is 'shader'; harmless otherwise
      polyhedron: { fillColor: item.color, fillOpacity: 0.85, strokeWidth: 0.1 },
    });
  }
  return board;
}

/** Bar, line or box plot from a list of numbers. */
/**
 * One implicit surface, drawn as however many sheets it needs.
 *
 * Each sheet is an (x, y) -> z function returning the nth root, or NaN where
 * there isn't one — which is what puts the hole outside a sphere's radius.
 * JSXGraph clips NaN cleanly, so the sheets end exactly where the surface does.
 */
function drawImplicitSurface(view, item, spec, steps) {
  // No z anywhere means it is a wall, and walls are extruded, not solved
  if (!mentionsZ(item.expr)) {
    return extrudeCurve(view, item.expr, item.color, spec);
  }

  const F = compileImplicit3d(item.expr);
  if (!F) return false;

  const sheets = sheetCount(F, spec.xRange, spec.yRange, spec.zRange);
  if (!sheets) return false;

  for (let sheet = 0; sheet < sheets; sheet++) {
    view.create("functiongraph3d", [
      (x, y) => {
        const roots = rootsInZ(F, x, y, spec.zRange[0], spec.zRange[1]);
        return sheet < roots.length ? roots[sheet] : NaN;
      },
      spec.xRange, spec.yRange,
    ], {
      strokeColor: item.color,
      // The mesh IS the surface here — functiongraph3d draws quad edges, so
      // hiding the stroke hides the lot. Keep it thin and slightly
      // transparent, and use a coarser grid than an explicit surface: a
      // solved sheet can be near-vertical at its rim, where dense quads pile
      // into an unreadable tangle.
      strokeWidth: 0.5,
      strokeOpacity: 0.55,
      fillColor: item.color,
      fillOpacity: 0.5,
      stepsU: IMPLICIT_STEPS,
      stepsV: IMPLICIT_STEPS,
      highlight: false,
    });
  }
  return true;
}

function buildStatsBoard(container, spec, interactive) {
  const data = spec.data ?? [];
  const max = Math.max(1, ...data);
  const min = Math.min(0, ...data);

  const board = JXG.JSXGraph.initBoard(container, {
    boundingbox: spec.chartType === "boxplot"
      ? [min - (max - min) * 0.2 - 1, 3, max + (max - min) * 0.2 + 1, -1]
      : [-1, max * 1.2 + 1, data.length + 1, min - Math.abs(min) * 0.2 - 1],
    axis: true,
    grid: false,
    showCopyright: false,
    showNavigation: false,
    keepaspectratio: false,
    pan: { enabled: interactive },
    zoom: { enabled: interactive, wheel: interactive },
  });

  board.suspendUpdate();
  if (spec.chartType === "boxplot") {
    const sorted = [...data].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1,
      Math.max(0, Math.round(q * (sorted.length - 1))))];
    // [min, q1, median, q3, max], axis position, width
    board.create("boxplot",
      [[at(0), at(0.25), at(0.5), at(0.75), at(1)], 1, 0.8],
      { strokeColor: spec.color, fillColor: spec.color, fillOpacity: 0.25 });
  } else {
    board.create("chart", [data], {
      chartStyle: spec.chartType === "line" ? "line,point" : "bar",
      width: 0.8,
      colors: [spec.color],
      highlight: false,
    });
  }
  board.unsuspendUpdate();
  return board;
}
