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
 * The surfaces in a 3D spec.
 * Older documents stored a single `expr`; read them as a one-item list so
 * a file saved before multi-surface support still opens.
 */
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
    const f = compileExpression(item.expr);
    if (!f) continue;
    board.create("functiongraph", [f], {
      strokeColor: item.color,
      strokeWidth: 2,
      highlight: false,
      fixed: true,
    });
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
    const f = compileSurface(item.expr);
    if (!f) continue;
    view.create("functiongraph3d", [f, spec.xRange, spec.yRange], {
      strokeColor: item.color,
      strokeWidth: 0.6,
      stepsU: steps,
      stepsV: steps,
      highlight: false,
    });
  }
  return board;
}

/** Bar, line or box plot from a list of numbers. */
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
