import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { palette } from "./draw.js";

// ─────────────────────────────────────────────
//  SIMULATION GRAPHS
//
//  One live graph of one simulation run: a
//  quantity against time, or any quantity
//  against any other. The same class draws the
//  graphs under a simulation and the copies in
//  the graphs panel on the right, so the two
//  always look and behave alike.
//
//  A graph does not own the run. Whoever shows
//  it (a simulation box, a panel section) calls
//  update() with the run every frame.
// ─────────────────────────────────────────────

/** A number short enough for an axis or a readout. */
export function short(value) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const a = Math.abs(value);
  if (a >= 1e4 || a < 1e-3) return value.toExponential(2).replace("e+", "e");
  return String(+value.toPrecision(3));
}

/** Index of the first sample at or after time `t`. */
export function firstAfter(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** A padded [min, max] that is never empty. */
function rangeOf(...arrays) {
  let min = Infinity, max = -Infinity;
  for (const values of arrays) {
    for (const v of values) {
      if (v == null || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) return [-1, 1];
  if (max - min < 1e-12) {
    const pad = Math.abs(min) * 0.1 || 1;
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.06;
  return [min - pad, max + pad];
}

/** A line through every point in order — for graphs whose x does not only go up. */
function xyPath(u, seriesIndex) {
  const [xs, ys] = u.data[seriesIndex];
  const path = new Path2D();
  let drawing = false;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) { drawing = false; continue; }
    const px = u.valToPos(x, "x", true), py = u.valToPos(y, "y", true);
    if (drawing) path.lineTo(px, py); else path.moveTo(px, py);
    drawing = true;
  }
  return { stroke: path, fill: null, clip: null, band: null, gaps: null, flags: 0 };
}

/** Samples of one quantity, from index `from` on. */
const seriesOf = (source, key, from) => (key === "t" ? source.history.t : source.history[key]).slice(from);

/** A comparison run's samples, lined up with these times. */
function alignedGhost(ghost, key, times, t0) {
  const gFrom = firstAfter(ghost.history.t, t0);
  const gt = ghost.history.t.slice(gFrom), gv = seriesOf(ghost, key, gFrom);
  let j = 0;
  return times.map((t) => {
    while (j < gt.length - 1 && gt[j + 1] <= t) j++;
    return gt.length ? gv[j] : null;
  });
}

/** The colour a quantity is always drawn in, wherever its graph is. */
export function graphColour(scenario, graph, index = 0) {
  const c = palette();
  const colours = [c.accent, c.good, c.warm, c.violet, c.bad];
  const keys = Object.keys(scenario.outputs);
  const at = keys.indexOf(graph.y);
  return colours[(at >= 0 ? at : index) % colours.length];
}

/**
 * The instant being pointed at, shared by a group of graphs. Hovering a
 * graph against time sets it; graphs of one quantity against another mark
 * it with a ring on their curve.
 */
export class Hover {
  constructor() {
    this.t = null;
    this.graphs = new Set();
  }
  set(t) {
    if (t === this.t) return;
    this.t = t;
    for (const g of this.graphs) if (!g.isTime) g.redraw();
  }
}

/** Axis settings, in the app's colours and font. */
function axes() {
  const c = palette();
  const axis = { stroke: c.dim, grid: { stroke: c.soft, width: 1 }, ticks: { stroke: c.soft },
                 font: `10px ${c.font}`, size: 34 };
  // Room for the numbers themselves: the tick marks and the gap take 15 px
  // before any text starts, so a fixed small size cuts digits off
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = axis.font;
  return {
    x: { ...axis, size: 30, values: (u, ticks) => ticks.map(short) },
    // Short graphs still get a few numbers up the side; the side grows to
    // fit the widest of them, "-0.15" as much as "8"
    y: {
      ...axis, space: 14, values: (u, ticks) => ticks.map(short),
      size: (u, values) => Math.max(28, Math.ceil(Math.max(0, ...(values ?? [])
        .map((v) => measure.measureText(String(v ?? "")).width))) + 18),
    },
  };
}

export class SimGraph {
  /**
   * @param graph    {x, y}: the quantity along the bottom and up the side
   * @param colour   the line's colour
   * @param width, height  in CSS pixels
   * @param syncKey  graphs against time with the same key share a cursor
   * @param hover    the Hover this graph reads and sets
   * @param compare  true when a comparison run is drawn dashed beside this one
   */
  constructor({ graph, colour, width, height, syncKey, hover, compare = false }) {
    this.graph = { x: graph.x, y: graph.y };
    this.isTime = graph.x === "t";
    this.colour = colour;
    this.hover = hover;
    this.times = [];

    this.holder = document.createElement("div");
    this.holder.className = "ntbk-sim-plot";
    /** The graph's legend and axis menus, over its top-left corner; filled by whoever shows it. */
    this.controls = document.createElement("div");
    this.controls.className = "ntbk-sim-axes";
    this.holder.appendChild(this.controls);

    const { x: xAxis, y: yAxis } = axes();
    const line = { stroke: colour, width: 1.6, points: { show: false } };
    const dashed = { stroke: colour, width: 1.2, dash: [5, 4], points: { show: false } };
    if (this.isTime) {
      const series = [{}, line];
      if (compare) series.push(dashed);
      this.plot = new uPlot({
        width, height, padding: [17, 10, 0, 0],
        cursor: { sync: { key: syncKey }, drag: { x: false, y: false } },
        legend: { show: false },
        scales: { x: { time: false } },
        axes: [xAxis, yAxis],
        series,
        hooks: {
          // Tell the other kind of graph which instant is being pointed at
          setCursor: [(u) => {
            const i = u.cursor.idx;
            hover?.set(i == null ? null : u.data[0][i]);
          }],
        },
      }, series.map(() => []), this.holder);
    } else {
      const facets = [{ scale: "x", auto: false }, { scale: "y", auto: false }];
      const series = [{}, { ...line, paths: xyPath, facets }];
      if (compare) series.push({ ...dashed, paths: xyPath, facets });
      this.plot = new uPlot({
        mode: 2,
        width, height, padding: [17, 10, 0, 0],
        cursor: { show: false },
        legend: { show: false },
        scales: { x: { time: false, auto: false }, y: { auto: false } },
        axes: [xAxis, yAxis],
        series,
        hooks: { draw: [(u) => this.markInstant(u)] },
      }, [null, ...series.slice(1).map(() => [[], []])], this.holder);
    }
    hover?.graphs.add(this);
  }

  /**
   * Show the run as it is now. `span` seconds of it (0: the whole run);
   * a time axis is a fixed window that slides, so a long run does not
   * squash its history.
   */
  update(run, ghost, span = 10) {
    const t0 = span ? Math.max(0, run.t - span) : 0;
    const from = firstAfter(run.history.t, t0);
    const times = run.history.t.slice(from);
    const { x, y } = this.graph;
    const plot = this.plot;
    if (this.isTime) {
      const data = [times, seriesOf(run, y, from)];
      if (ghost) data.push(alignedGhost(ghost, y, times, t0));
      plot.batch(() => {
        plot.setData(data, true);
        plot.setScale("x", { min: t0, max: span ? Math.max(t0 + span, run.t) : Math.max(run.t, 1e-6) });
      });
    } else {
      const xs = seriesOf(run, x, from), ys = seriesOf(run, y, from);
      const data = [null, [xs, ys]];
      const ranges = [[xs], [ys]];
      if (ghost) {
        const gx = alignedGhost(ghost, x, times, t0), gy = alignedGhost(ghost, y, times, t0);
        data.push([gx, gy]);
        ranges[0].push(gx); ranges[1].push(gy);
      }
      this.times = times;
      const [xMin, xMax] = rangeOf(...ranges[0]);
      const [yMin, yMax] = rangeOf(...ranges[1]);
      plot.batch(() => {
        plot.setData(data, false);
        plot.setScale("x", { min: xMin, max: xMax });
        plot.setScale("y", { min: yMin, max: yMax });
      });
    }
  }

  /** On a graph of one quantity against another: a dot at now, a ring at the hovered instant. */
  markInstant(u) {
    const [xs, ys] = u.data[1] ?? [[], []];
    if (!xs.length) return;
    const ctx = u.ctx;
    const dot = (i, filled) => {
      const px = u.valToPos(xs[i], "x", true), py = u.valToPos(ys[i], "y", true);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, (filled ? 3.5 : 5) * devicePixelRatio, 0, Math.PI * 2);
      ctx.strokeStyle = this.colour;
      ctx.fillStyle = this.colour;
      ctx.lineWidth = 1.5 * devicePixelRatio;
      filled ? ctx.fill() : ctx.stroke();
      ctx.restore();
    };
    dot(xs.length - 1, true);
    const t = this.hover?.t;
    if (t != null && this.times.length) dot(Math.min(this.times.length - 1, firstAfter(this.times, t)), false);
  }

  redraw() { this.plot.redraw(false, false); }

  destroy() {
    this.hover?.graphs.delete(this);
    this.plot.destroy();
    this.holder.remove();
  }
}
