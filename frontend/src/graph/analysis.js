import { compileExpression } from "./GraphRenderer.js";

// ─────────────────────────────────────────────
//  WHAT A 2D PLOT ACTUALLY SHOWS
//
//  Everything here is NUMERIC. There is no
//  symbolic solver in the app, so a root is
//  found by watching the sign of f change and
//  halving the interval until it stops moving.
//
//  That has a consequence worth stating plainly:
//  a root the sampling steps over is a root we
//  do not report. Touching roots (x^2 at 0, where
//  f never changes sign) are caught by a separate
//  near-zero-minimum check, but a function that
//  oscillates faster than SAMPLES can still hide
//  one. Raising SAMPLES narrows the gap; it never
//  closes it.
// ─────────────────────────────────────────────
const SAMPLES = 2000;       // across the visible x range
// Past this many roots or turning points the function is oscillating faster
// than the panel can usefully describe. sin(e^x) over [-8, 8] has 256 roots
// in view — listing them is neither readable nor cheap, so the count is
// reported honestly and the coordinates are capped.
const MAX_LISTED = 24;
const BISECT = 60;          // halvings once a root is bracketed
const TOUCH_EPS = 1e-7;     // |f| below this at a local min counts as a root
const NEAR = 1e-9;

/** f, sampled across [a, b], with the gaps where it is undefined recorded. */
function sample(f, a, b, n = SAMPLES) {
  const xs = [], ys = [];
  for (let i = 0; i <= n; i++) {
    const x = a + (b - a) * (i / n);
    xs.push(x);
    ys.push(f(x));
  }
  return { xs, ys };
}

/** Contiguous runs where the function returned a real number. */
function domainPieces(xs, ys) {
  const pieces = [];
  let start = null;
  for (let i = 0; i < ys.length; i++) {
    const ok = Number.isFinite(ys[i]);
    if (ok && start === null) start = xs[i];
    if (!ok && start !== null) { pieces.push([start, xs[i - 1]]); start = null; }
  }
  if (start !== null) pieces.push([start, xs[xs.length - 1]]);
  return pieces;
}

/** Bisect a bracketed sign change. */
function bisect(f, lo, hi) {
  let flo = f(lo);
  for (let i = 0; i < BISECT; i++) {
    const mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (!Number.isFinite(fmid)) return null;
    if (Math.abs(fmid) < NEAR) return mid;
    if ((flo < 0) === (fmid < 0)) { lo = mid; flo = fmid; } else { hi = mid; }
  }
  return (lo + hi) / 2;
}

/**
 * Where f crosses zero, and where it merely touches it.
 *
 * A crossing is a sign change and is exact to within BISECT halvings. A touch
 * — x^2 at the origin — never changes sign, so it is found as a local minimum
 * whose value is within TOUCH_EPS of zero. That threshold is a judgement, not
 * a fact: a genuine minimum of 1e-8 will be reported as a root.
 */
export function rootsOf(f, a, b) {
  const { xs, ys } = sample(f, a, b);
  const found = [];
  for (let i = 1; i < xs.length; i++) {
    const y0 = ys[i - 1], y1 = ys[i];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    if (y0 === 0) { found.push(xs[i - 1]); continue; }
    if ((y0 < 0) !== (y1 < 0)) {
      const r = bisect(f, xs[i - 1], xs[i]);
      if (r !== null) found.push(r);
    }
  }
  // A root ON the edge of the window is never bracketed, because there is no
  // sample beyond it to change sign against. sin(x) over [-pi, pi] has three
  // roots and the naive scan finds one.
  for (const edge of [a, b]) {
    const y = f(edge);
    if (Number.isFinite(y) && Math.abs(y) < TOUCH_EPS) found.push(edge);
  }

  // touching roots: a local minimum of |f| that sits on the axis
  for (let i = 1; i < xs.length - 1; i++) {
    const a0 = Math.abs(ys[i - 1]), a1 = Math.abs(ys[i]), a2 = Math.abs(ys[i + 1]);
    if (!Number.isFinite(a0) || !Number.isFinite(a1) || !Number.isFinite(a2)) continue;
    if (a1 <= a0 && a1 <= a2 && a1 < TOUCH_EPS) found.push(xs[i]);
  }
  return dedupe(found);
}

/**
 * Does this function have a pole in view?
 *
 * Two shapes, and they need different tests.
 *
 * 1/x leaves a GAP in the domain — 1/0 is not finite — so the pole sits
 * between two pieces. Probing inside that gap separates a pole from an
 * ordinary end of the domain: 1/x returns enormous numbers in there, while
 * sqrt(x) below zero returns NaN all the way across.
 *
 * tan(x) leaves no gap at all, because no sample lands exactly on pi/2. It
 * gives itself away differently: two neighbouring samples with huge values
 * and opposite signs, which a continuous function cannot do.
 *
 * This matters because with a pole in view the sampled max is an artefact of
 * SAMPLES, not a fact about the function — quoting it as the maximum would be
 * inventing a number.
 */
function hasPole(f, pieces, xs, ys) {
  // "Huge" is judged against the function's own typical size. An absolute
  // threshold cannot work for both tan over [-3, 3], which only reaches ~830
  // at this sampling density, and x^3 over a wide window, which passes 1e6
  // with no pole at all.
  const magnitudes = ys.filter(Number.isFinite).map(Math.abs).sort((p, q) => p - q);
  if (!magnitudes.length) return false;
  const median = magnitudes[Math.floor(magnitudes.length / 2)] || 1e-6;
  const huge = Math.max(50, median * 200);

  // 1. A gap in the domain with enormous values inside it. Probing separates
  //    a pole from an ordinary end of the domain: 1/x returns huge numbers
  //    across the gap, sqrt(x) below zero returns NaN all the way.
  for (let i = 1; i < pieces.length; i++) {
    const from = pieces[i - 1][1], to = pieces[i][0];
    for (let k = 1; k < 40; k++) {
      const y = Math.abs(f(from + (to - from) * (k / 40)));
      if (Number.isFinite(y) && y > huge) return true;
    }
  }

  // 2. A sign flip between two enormous values. Written to skip OVER
  //    non-finite samples rather than stopping at them, because a pole the
  //    grid lands on exactly — 1/(x-2) sampled at x = 2 — puts an Infinity
  //    between the two neighbours that give it away, and comparing only
  //    adjacent pairs would never see them.
  let prev = null;
  for (let i = 0; i < ys.length; i++) {
    if (!Number.isFinite(ys[i])) continue;
    if (prev !== null && Math.abs(prev) > huge && Math.abs(ys[i]) > huge
        && (prev < 0) !== (ys[i] < 0)) return true;
    prev = ys[i];
  }
  return false;
}

function dedupe(values, tol = 1e-6) {
  const sorted = [...values].sort((p, q) => p - q);
  const out = [];
  for (const v of sorted) {
    if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  }
  return out;
}

/** Turning points, by refining each local extremum in the sample. */
function extrema(f, xs, ys) {
  const out = [];
  for (let i = 1; i < xs.length - 1; i++) {
    const y0 = ys[i - 1], y1 = ys[i], y2 = ys[i + 1];
    if (![y0, y1, y2].every(Number.isFinite)) continue;
    const isMax = y1 >= y0 && y1 >= y2 && (y1 > y0 || y1 > y2);
    const isMin = y1 <= y0 && y1 <= y2 && (y1 < y0 || y1 < y2);
    if (!isMax && !isMin) continue;
    // golden-section refine inside the bracketing sample interval
    let lo = xs[i - 1], hi = xs[i + 1];
    const phi = (Math.sqrt(5) - 1) / 2;
    for (let k = 0; k < 60; k++) {
      const c = hi - (hi - lo) * phi, d = lo + (hi - lo) * phi;
      const fc = f(c), fd = f(d);
      if (!Number.isFinite(fc) || !Number.isFinite(fd)) break;
      if (isMax ? fc > fd : fc < fd) hi = d; else lo = c;
    }
    const x = (lo + hi) / 2;
    const y = f(x);
    if (Number.isFinite(y)) out.push({ x, y, kind: isMax ? "max" : "min" });
  }
  return out;
}

/** Everything the Details tab shows about one plotted function. */
export function analyse(expr, bounds) {
  const f = compileExpression(expr);
  if (!f) return { ok: false, error: "could not read this expression" };
  const [a, b] = bounds;

  const { xs, ys } = sample(f, a, b);
  const finite = ys.filter(Number.isFinite);
  if (!finite.length) return { ok: false, error: "undefined everywhere in view" };

  const pieces = domainPieces(xs, ys);
  const turning = extrema(f, xs, ys);
  const roots = rootsOf(f, a, b);

  // The extremes over the WINDOW, which is not the same as the extremes of
  // the function — say so in the label rather than claiming a global result.
  let yMin = Infinity, yMax = -Infinity, xAtMin = NaN, xAtMax = NaN;
  for (let i = 0; i < ys.length; i++) {
    if (!Number.isFinite(ys[i])) continue;
    if (ys[i] < yMin) { yMin = ys[i]; xAtMin = xs[i]; }
    if (ys[i] > yMax) { yMax = ys[i]; xAtMax = xs[i]; }
  }

  // A vertical asymptote makes the sampled extreme meaningless: 1/x over
  // [-5, 5] "peaks" at whatever the sample nearest zero happened to hit, which
  // says more about SAMPLES than about the function. Detect it by stepping
  // toward each interior gap edge and watching |f| grow, and report the range
  // as unbounded rather than quoting a number that is an artefact.
  const unbounded = hasPole(f, pieces, xs, ys);

  // Reported separately from the capped lists, so the panel can say "256
  // roots" while only drawing the first few. Hiding the true count would be
  // worse than the wall of numbers.
  const rootCount = roots.length;
  const turningCount = turning.length;

  return {
    ok: true,
    unbounded,
    rootCount,
    turningCount,
    crowded: rootCount > MAX_LISTED || turningCount > MAX_LISTED,
    domain: pieces,
    wholeWindowDefined: pieces.length === 1
      && Math.abs(pieces[0][0] - a) < (b - a) / SAMPLES * 2
      && Math.abs(pieces[0][1] - b) < (b - a) / SAMPLES * 2,
    range: [yMin, yMax],
    min: { x: xAtMin, y: yMin },
    max: { x: xAtMax, y: yMax },
    turning: turning.slice(0, MAX_LISTED),
    roots: roots.slice(0, MAX_LISTED),
  };
}

/** Where two plotted functions meet, found on f - g. */
export function intersections(exprA, exprB, bounds) {
  const f = compileExpression(exprA), g = compileExpression(exprB);
  if (!f || !g) return [];
  const d = (x) => {
    const p = f(x), q = g(x);
    return Number.isFinite(p) && Number.isFinite(q) ? p - q : NaN;
  };
  return rootsOf(d, bounds[0], bounds[1]).map((x) => ({ x, y: f(x) }));
}
