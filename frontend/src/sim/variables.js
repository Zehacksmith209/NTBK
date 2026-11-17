import { parse, isUnit, format, Unit } from "mathjs";
import { symbolTex } from "../formulas/library.js";

// ─────────────────────────────────────────────
//  NOTEBOOK VARIABLES
//
//  Write `k = 200 N/m` once, in a Variables box
//  on the page, and every simulation, formula
//  and plot in the notebook can use `k`.
//
//  Every Variables box in the notebook adds to
//  one shared list, read in page order — top to
//  bottom, the way the notebook is read — so a
//  later line can use an earlier one, and a
//  name defined twice takes the later value.
//
//  Values keep their units (mathjs units), so
//  `F = m * a` with m in kg and a in m/s^2 comes
//  out in newtons, and a simulation asking for a
//  stiffness in N/m can refuse a mass.
// ─────────────────────────────────────────────

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)(.*)$/;

// ── Units straight after a number ──────────
//
// Physics names collide with unit names all the time: m is a mass and a
// metre, s a distance and a second, g gravity and a gram, A, V, T, F, W…
// mathjs looks a name up among the variables first, so with a variable m
// defined, "200 N/m" quietly became newtons per KILOGRAM.
//
// The rule, which is also how it is written on paper: a unit written
// straight after its number is a unit, whatever variables exist. A run of
// units continues across * and / only with no spaces ("9.81 m/s^2"), so
// "2 m * a" is two metres times a, not two metre-years.
const NUMBER_UNIT = /(^|[^A-Za-z0-9_.])((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s?((?:[A-Za-z\u00b0\u00b5\u03a9]+(?:\^-?\d+(?:\.\d+)?)?)(?:[*/](?:[A-Za-z\u00b0\u00b5\u03a9]+(?:\^-?\d+(?:\.\d+)?)?))*)(?![A-Za-z0-9_(])/g;

function isUnitString(text) {
  try { Unit.parse(text); return true; } catch { return false; }
}

/** "0.2 1/s" and "4 1/s^2": a per-unit value, written the way it is on paper. */
const NUMBER_PER_UNIT = /(^|[^A-Za-z0-9_.])((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+1\s*\/\s*([A-Za-z\u00b5\u03a9]+)(?:\^(\d+(?:\.\d+)?))?(?![A-Za-z0-9_(^*/])/g;

/** "200 N/m" → "unit(200, \"N/m\")", leaving everything else alone. */
export function lockUnits(text) {
  return String(text)
    .replace(NUMBER_PER_UNIT, (all, before, number, unit, power) =>
      (isUnitString(unit) ? `${before}unit(${number}, "${unit}^-${power ?? 1}")` : all))
    .replace(NUMBER_UNIT, (all, before, number, units) =>
      isUnitString(units) ? `${before}unit(${number}, "${units}")` : all);
}

/**
 * Evaluate something a person typed — a variable, a simulation input, a
 * formula value — against the notebook's variables, with units locked to
 * their numbers.
 */
export function evaluateTyped(text, scope = current.scope) {
  const node = parse(lockUnits(text));
  return { node, value: node.evaluate({ ...scope }) };
}

/** Constants that are already names in mathjs and must not be redefined by accident. */
const RESERVED = new Set(["pi", "e", "i", "Infinity", "NaN", "true", "false", "tau", "phi"]);

let current = { lines: [], scope: {}, numeric: {}, byName: new Map(), key: "" };

/** One parsed line of a Variables box. */
function readLine(text, scope) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("%")) {
    return { kind: "comment", text };
  }
  const m = LINE.exec(text);
  if (!m) return { kind: "error", text, error: "Write it as  name = value" };
  const name = m[1];
  const expr = m[2].replace(/\s+#.*$/, "").trim();
  if (!expr) return { kind: "error", text, name, error: "No value after =" };
  if (RESERVED.has(name)) return { kind: "error", text, name, error: `${name} is a built-in constant` };
  let node, value;
  try {
    ({ node, value } = evaluateTyped(expr, scope));
  } catch (error) {
    return { kind: "error", text, name, expr,
             error: String(error.message ?? error).replace(/^Error:\s*/, "") };
  }
  if (typeof value === "function" || value === undefined) {
    return { kind: "error", text, name, expr, error: "That is not a value" };
  }
  return { kind: "value", text, name, expr, node, value };
}

/** Objects in reading order: by page, then down the page, then across. */
function readingOrder(objects, pages) {
  const pageOf = (o) => {
    const cy = o.y + (o.h ?? 0) / 2;
    const page = pages.find((p) => cy >= p.y && cy <= p.y + p.h);
    return page ? page.index : Number.MAX_SAFE_INTEGER;
  };
  return [...objects].sort((a, b) => pageOf(a) - pageOf(b) || a.y - b.y || a.x - b.x);
}

/**
 * Re-read every Variables box. Returns true when any value changed, and
 * tells the rest of the page so plots and simulations can pick it up.
 */
export function refreshVariables(store) {
  const boxes = readingOrder(store.objects.filter((o) => o.type === "vars"),
                             store.data.canvas.pages ?? []);
  const scope = {};
  const perBox = new Map();
  for (const box of boxes) {
    const lines = String(box.payload?.source ?? "").split("\n").map((text) => {
      const line = readLine(text, scope);
      if (line.kind === "value") scope[line.name] = line.value;
      return line;
    });
    perBox.set(box.id, lines);
  }

  // The same values as plain SI numbers, for plots, which draw numbers
  const numeric = {};
  for (const [name, value] of Object.entries(scope)) {
    const n = toNumber(value);
    if (Number.isFinite(n)) numeric[name] = n;
  }

  const key = JSON.stringify(Object.entries(scope).map(([n, v]) => [n, format(v, { precision: 12 })]));
  const changed = key !== current.key;
  current = { perBox, scope, numeric, key,
              byName: new Map(Object.entries(scope)) };
  // "read" every time, so each box shows its own lines; "variables" only when
  // a value moved, which is what makes plots and simulations recompute
  window.dispatchEvent(new CustomEvent("ntbk:variables-read"));
  if (changed) window.dispatchEvent(new CustomEvent("ntbk:variables"));
  return changed;
}

/** A value as a plain number in SI base units (a number stays as it is). */
export function toNumber(value) {
  if (typeof value === "number") return value;
  if (isUnit(value)) {
    try { return value.toSI().toNumber(); } catch { return NaN; }
  }
  return NaN;
}

/** Every variable, with units, for mathjs to evaluate against. */
export function variableScope() {
  return { ...current.scope };
}

/** Every variable as a plain SI number, for plots. */
export function numericScope() {
  return current.numeric;
}

export function hasVariable(name) {
  return current.byName.has(name);
}

export function variableValue(name) {
  return current.byName.get(name);
}

export function linesOf(boxId) {
  return current.perBox.get(boxId) ?? null;
}

/** Every name a piece of maths uses, so a field can say what it is linked to. */
export function namesUsed(expr) {
  try {
    const names = new Set();
    parse(String(expr)).traverse((node, path, parent) => {
      if (node.isSymbolNode && !(parent?.isFunctionNode && path === "fn")) names.add(node.name);
    });
    return [...names].filter((n) => current.byName.has(n));
  } catch {
    return [];
  }
}

// ── Showing them ────────────────────────────

/** Is this symbol a unit (upright) rather than a variable (italic)? */
function isUnitName(name) {
  if (current.byName.has(name)) return false;
  try { return Unit.isValuelessUnit(name); } catch { return false; }
}

/** "N*m^2/kg^2" → upright TeX. */
export function unitTex(units) {
  return units.replace(/\^(-?[\d.]+)/g, "^{$1}").split(/([*/])/)
    .map((part) => (part === "*" ? "\\cdot " : part === "/" ? "/"
      : `\\mathrm{${part.replace(/\u03a9/g, "\\Omega").replace(/\u00b5/g, "\\mu ")
          .replace(/\u00b0/g, "^{\\circ}")}}`)).join("");
}

const texOptions = {
  parenthesis: "auto",
  implicit: "hide",
  handler: (node, options) => {
    // A number with its unit, as lockUnits() wrote it
    if (node.isFunctionNode && node.fn?.name === "unit" && node.args.length === 2
        && node.args[1].isConstantNode) {
      return `${node.args[0].toTex(options)}\\,${unitTex(String(node.args[1].value))}`;
    }
    if (!node.isSymbolNode) return undefined;
    return isUnitName(node.name) ? ` \\mathrm{${node.name}}` : ` ${symbolTex(node.name)}`;
  },
};

/** A value as TeX, with its unit upright: 7.07 rad/s, 39.2 N. */
/** "N s / m" → "N*s/m", "m / (s s)" → "m/(s*s)": a unit string mathjs reads back. */
export function unitString(value, simplify = true) {
  const simple = simplify && typeof value.simplify === "function" ? value.simplify() : value;
  return simple.formatUnits()
    .replace(/\(([^)]*)\)/g, (_, inner) => `(${inner.trim().replace(/\s+/g, "*")})`)
    .replace(/\s*\/\s*/g, "/").trim().replace(/\s+/g, "*")
    .replace(/^\(([^()]*)\)\//, "$1/");          // (N*s)/m → N*s/m
}

export function valueTex(value) {
  if (isUnit(value)) {
    // simplify() turns kg·m/s² back into N, and √(N/(m·kg)) into Hz
    const simple = typeof value.simplify === "function" ? value.simplify() : value;
    const number = simple.toNumber();
    const units = unitString(simple);
    const n = format(number, { precision: 5 });
    return units ? `${n.replace(/e\+?(-?\d+)/, "\\times 10^{$1}")}\\,${unitTex(units)}` : n;
  }
  const text = format(value, { precision: 5 });
  if (/^-?[\d.]+(e[+-]?\d+)?$/.test(text)) return text.replace(/e\+?(-?\d+)/, "\\times 10^{$1}");
  return `\\text{${text.replace(/[\\{}$&#^_%~]/g, "")}}`;
}

/** One line as TeX: the definition, then its value if that says something new. */
export function lineTex(line) {
  if (line.kind !== "value") return "";
  const left = symbolTex(line.name);
  let expr;
  try { expr = line.node.toTex(texOptions); } catch { expr = line.expr; }
  const shown = valueTex(line.value);
  // "m = 2 kg" says everything already; "w = sqrt(k/m)" needs its answer
  const literal = line.node.isConstantNode
    || (line.node.isFunctionNode && line.node.fn?.name === "unit");
  return literal || expr.replace(/\s/g, "") === shown.replace(/\s/g, "")
    ? `${left} = ${expr}`
    : `${left} = ${expr} = ${shown}`;
}
