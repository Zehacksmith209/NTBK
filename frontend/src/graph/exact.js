// ─────────────────────────────────────────────
//  "EXACT" FORM
//
//  Read this before trusting it.
//
//  The app has no symbolic solver. Roots arrive
//  as floats from a bisection, so nothing here
//  DERIVES √2 — it RECOGNISES that a float looks
//  like √2 and says so.
//
//  That means it is a very good guess, not a
//  proof. 1.41421356 is reported as √2 because
//  squaring it lands within tolerance of 2. A
//  number that is genuinely 1.414213562 and not
//  √2 would be mislabelled, and no amount of
//  precision fixes that in principle.
//
//  So: only offered alongside the decimal, never
//  instead of it, and only when the match is
//  tight (TOL). Anything uncertain shows as a
//  decimal, which is always true.
// ─────────────────────────────────────────────
const TOL = 1e-9;
const MAX_DEN = 64;       // denominators past this stop looking "exact"
const MAX_RADICAND = 200;

/** Continued-fraction search for p/q ≈ v. */
function asFraction(v, maxDen = MAX_DEN) {
  let h1 = 1, h0 = 0, k1 = 0, k0 = 1, x = v;
  for (let i = 0; i < 24; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    if (Math.abs(v - h1 / k1) < TOL) return { p: h1, q: k1 };
    const frac = x - a;
    if (Math.abs(frac) < 1e-15) break;
    x = 1 / frac;
  }
  return Math.abs(v - h1 / k1) < TOL ? { p: h1, q: k1 } : null;
}

const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));

/** p/q in lowest terms, sign carried on the numerator. */
function reduce(p, q) {
  if (q < 0) { p = -p; q = -q; }
  const g = gcd(p, q) || 1;
  return { p: p / g, q: q / g };
}

const frac = (p, q) => {
  const r = reduce(p, q);
  return r.q === 1 ? String(r.p) : `${r.p}/${r.q}`;
};

/**
 * p/q times a symbol, written the way it is written by hand.
 *
 * Not `1/2·π` but `π/2`; not `2/4·√5` but `√5/2`. The coefficient goes in
 * front, the denominator underneath, and a coefficient of 1 disappears.
 */
function times(p, q, symbol) {
  const r = reduce(p, q);
  const sign = r.p < 0 ? "-" : "";
  const mag = Math.abs(r.p);
  const head = mag === 1 ? symbol : `${mag}${symbol}`;
  return r.q === 1 ? `${sign}${head}` : `${sign}${head}/${r.q}`;
}

/**
 * A short exact-looking form for v, or null when nothing fits.
 *
 * Order matters: a plain rational is checked first so 2 does not come back as
 * √4, and multiples of π before radicals because π/2 reads better than the
 * fraction of an irrational it also happens to match.
 */
export function toExact(v) {
  if (!Number.isFinite(v)) return null;
  if (Math.abs(v) < TOL) return "0";

  const r = asFraction(v);
  if (r) return frac(r.p, r.q);

  const overPi = asFraction(v / Math.PI, 16);
  if (overPi) return times(overPi.p, overPi.q, "π");

  // k·√n — square it and look for a rational, then split off the square part
  const sq = asFraction(v * v, 16);
  if (sq && sq.p > 0 && sq.p <= MAX_RADICAND * sq.q) {
    const n = sq.p * sq.q;                   // √(p/q) = √(pq)/q
    const root = Math.sqrt(n);
    if (Number.isInteger(root)) return frac(Math.sign(v) * root, sq.q);
    if (n <= MAX_RADICAND && Number.isInteger(n)) {
      let outside = 1, inside = n;
      for (let k = 2; k * k <= inside; k++) {
        while (inside % (k * k) === 0) { inside /= k * k; outside *= k; }
      }
      const sign = v < 0 ? -1 : 1;
      const num = sign * outside;
      if (inside === 1) return frac(num, sq.q);
      return times(num, sq.q, `√${inside}`);
    }
  }
  return null;
}

/** How a coordinate is shown, in whichever mode the panel is in. */
export function formatValue(v, mode, places = 4) {
  if (!Number.isFinite(v)) return "—";
  if (mode === "exact") {
    const e = toExact(v);
    if (e) return e;
  }
  const rounded = Number(v.toFixed(places));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function formatPoint(x, y, mode) {
  return `(${formatValue(x, mode)}, ${formatValue(y, mode)})`;
}
