import { parse, unit as makeUnit, isUnit, divide, multiply, ConstantNode } from "mathjs";
import {
  evaluateTyped, lockUnits, hasVariable, variableScope, unitString, unitTex,
} from "./variables.js";
import { symbolTex } from "../formulas/library.js";
import { SvgStage } from "./svg.js";

// ─────────────────────────────────────────────
//  YOUR OWN MODEL
//
//  A simulation written as the maths, the way
//  it is written in notes:
//
//    m*x'' + c*x' + k*x = F0*cos(w*t)   equation of motion
//    k = 40 N/m                         an input
//    x(0) = 0.2 m                       a starting value
//    E = 1/2*m*x'^2 + 1/2*k*x^2         a quantity to graph
//    draw block at (x, 0) size 0.2      a shape tied to it
//
//  ntbk works out which quantities move
//  (anything with a rate x' or x''), solves the
//  equations for the highest rates each step,
//  checks the units on both sides, and typesets
//  every line. Nothing is written in code and
//  nothing is run as code: every expression goes
//  through the same maths parser the Variables
//  box uses.
// ─────────────────────────────────────────────

export const STARTER = `# Mass on a spring
m*x'' + c*x' + k*x = F0*cos(w*t)

m = 1 kg
k = 40 N/m
c = 0.8 N*s/m
F0 = 0 N
w = 6 rad/s

x(0) = 0.2 m
x'(0) = 0 m/s

E = 1/2*m*x'^2 + 1/2*k*x^2

draw wall from (-1, 0.3) to (-1, -0.3)
draw ground from (-1, -0.12) to (1, -0.12)
draw spring from (-1, 0) to (x - 0.12, 0)
draw block at (x, 0) size 0.24 label "m"
draw arrow from (x, 0.2) by (x'/8, 0) colour good`;

/** The shapes a draw line can ask for. */
/** Worked models, offered under Insert > Simulate > Your own. Each one is a starting point to change. */
export const EXAMPLES = [
  {
    id: "mass-spring-damper",
    title: "Mass–spring–damper",
    category: "Mechanical",
    summary: "A block on a spring with a damper, free or driven",
    text: `# Mass–spring–damper
m*x'' + c*x' + k*x = F_0*cos(omega_d*t)

m = 1 kg
k = 40 N/m
c = 0.8 N*s/m
F_0 = 0 N
omega_d = 6 rad/s

x(0) = 0.2 m
x'(0) = 0 m/s

v = x'
a = x''
F_s = -k*x
F_d = -c*x'
F = F_0*cos(omega_d*t)
KE = 1/2*m*x'^2
U = 1/2*k*x^2
E = KE + U

omega_n = sqrt(k/m)
f_n = omega_n/(2*pi)
T_n = 2*pi/omega_n
zeta = c/(2*sqrt(k*m))
r = omega_d/omega_n
X_steady = (F_0/k)/sqrt((1 - r^2)^2 + (2*zeta*r)^2)

graph x
graph v
graph a
graph E
graph F_s against x

draw wall from (-0.45, 0.13) to (-0.45, -0.06)
draw ground from (-0.45, -0.06) to (0.6, -0.06)
draw line from (0, 0.1) to (0, -0.06) colour dim
draw label "x = 0" at (0, 0.13)
draw spring from (-0.45, 0.025) to (x - 0.06, 0.025) turns 9
draw damper from (-0.45, -0.03) to (x - 0.06, -0.03)
draw block at (x, 0) size 0.12 label "m"
draw arrow from (x, 0.09) by (x'/8, 0) colour good
draw arrow from (x + 0.06, 0) by (F/100, 0) colour warm label "F"`,
  },
  {
    id: "incline",
    title: "Block sliding down a slope",
    category: "Mechanical",
    summary: "A block on a rough slope, starting from rest: weight, normal force and friction",
    text: `# Block sliding down a slope
m*s'' = m*g*sin(theta) - Ff
m = 2 kg
g = 9.81 m/s^2
theta = 30 deg
mu = 0.2
L = 4 m
b = 0.4 m
s(0) = 0 m
s'(0) = 0 m/s
N = m*g*cos(theta)
Ff = min(mu*N, m*g*sin(theta))
T = sqrt(2*m*L/(m*g*sin(theta) - Ff))
vend = sqrt(2*L*(m*g*sin(theta) - Ff)/m)
X = s*cos(theta) + b/2*sin(theta)
Y = (L - s)*sin(theta) + b/2*cos(theta)
KE = 1/2*m*s'^2
stop when s >= L
draw ground from (-0.4, 0) to (L*cos(theta) + 0.6, 0)
draw ground from (0, L*sin(theta)) to (L*cos(theta), 0)
draw line from (0, 0) to (0, L*sin(theta))
draw block at (X, Y) size b angle -theta label "m"
draw arrow from (X, Y) by (0, -m*g/20) colour bad label "mg"
draw arrow from (X, Y) by (N/20*sin(theta), N/20*cos(theta)) colour good label "N"
draw arrow from (X, Y) by (-Ff/20*cos(theta), Ff/20*sin(theta)) colour violet label "F"`,
  },
];

export const SHAPES = ["ground", "wall", "spring", "damper", "rod", "string", "line",
  "block", "circle", "point", "pivot", "arrow", "trace", "label"];

const DERIV = /([A-Za-z_][A-Za-z0-9_]*)('+)/g;
/** x'' → x__dd, so the maths parser can read it. */
export const plain = (text) => String(text).replace(DERIV, (_, n, p) => `${n}__${"d".repeat(p.length)}`);

function unplain(sym) {
  const m = /^(.*?)__(d+)$/.exec(sym);
  return m ? { name: m[1], order: m[2].length } : { name: sym, order: 0 };
}
const rateSym = (name, order) => (order ? `${name}__${"d".repeat(order)}` : name);
const rateKey = (name, order) => name + "'".repeat(order);

/** F0 reads as F₀; th as θ is left to symbolTex (theta works). */
function nameTex(name) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(name);
  return m ? `${symbolTex(m[1])}_{${m[2]}}` : symbolTex(name);
}

function texOf(sym) {
  const { name, order } = unplain(sym);
  const base = nameTex(name);
  return order === 0 ? base : order === 1 ? `\\dot{${base}}`
    : order === 2 ? `\\ddot{${base}}` : `${base}^{(${order})}`;
}
const texOptions = {
  parenthesis: "auto",
  handler: (node, options) => {
    if (node.isSymbolNode) return ` ${texOf(node.name)}`;
    // "0.5 kg" was locked into unit(0.5, "kg") for the parser; show it as written
    if (node.isFunctionNode && node.fn?.name === "unit" && node.args?.length === 2) {
      return `${node.args[0].toTex(options)}\\,${unitTex(String(node.args[1].value ?? ""))}`;
    }
    return undefined;
  },
};
// m·ẍ reads as mẍ, as it is written by hand; 2·3 keeps its dot
const nodeTex = (node) => {
  try {
    return node.toTex(texOptions).replace(/(?<=[A-Za-z0-9}])\\cdot(?=\s*(?:\\[A-Za-z]|[A-Za-z{]))/g, "\\,");
  } catch { return "?"; }
};

const CONSTANTS = new Set(["pi", "e", "tau", "phi", "Infinity", "i"]);

/** Names an expression uses, function names left out. */
function symbolsOf(node) {
  const names = new Set();
  node.traverse((n, path, parent) => {
    if (n.isSymbolNode && !(parent?.isFunctionNode && path === "fn")) names.add(n.name);
  });
  return [...names].filter((n) => !CONSTANTS.has(n));
}

/** "a = b" split at its one equals sign; null when there isn't exactly one. */
function splitEquals(text) {
  // Only a real equals sign: not the one inside >=, <=, == or !=
  const parts = text.split(/(?<![<>=!])=(?!=)/);
  if (parts.length !== 2) return null;
  const [lhs, rhs] = parts.map((s) => s.trim());
  return lhs && rhs ? [lhs, rhs] : null;
}

function tryParse(text) {
  try { return { node: parse(lockUnits(plain(text))) }; }
  catch (error) { return { error: String(error.message ?? error).replace(/^Error:\s*/, "") }; }
}

// ───────────────── Reading the lines ─────────────────

const DRAW_KEYS = new Set(["at", "from", "to", "by", "of", "size", "r", "radius", "label", "colour", "color", "turns", "angle"]);

/** "draw spring from (-1, 0) to (x, 0) colour good" → a shape with expressions. */
function parseDraw(rest, line) {
  const words = rest.trim();
  const m = /^([a-z]+)\s*(.*)$/i.exec(words);
  if (!m) return { error: "draw what? e.g.  draw block at (x, 0) size 0.2" };
  const kind = m[1].toLowerCase();
  if (!SHAPES.includes(kind)) return { error: `“${kind}” isn't a shape. Try: ${SHAPES.join(", ")}` };
  const shape = { kind, line, points: {}, options: {} };
  let text = m[2];
  let key = null;
  while (text.length) {
    text = text.replace(/^\s+/, "");
    if (!text) break;
    if (text[0] === "(") {
      let depth = 0, i = 0;
      for (; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) break;
      }
      if (depth) return { error: "a bracket isn't closed" };
      const inner = text.slice(1, i);
      // Split at the top-level comma
      let d = 0, cut = -1;
      for (let j = 0; j < inner.length; j++) {
        if (inner[j] === "(") d++; else if (inner[j] === ")") d--;
        else if (inner[j] === "," && d === 0) { cut = j; break; }
      }
      if (cut < 0) return { error: "a point needs two parts: (x, y)" };
      const slot = key ?? "at";
      shape.points[slot] = [inner.slice(0, cut).trim(), inner.slice(cut + 1).trim()];
      text = text.slice(i + 1);
      key = null;
    } else if (text[0] === '"') {
      const end = text.indexOf('"', 1);
      if (end < 0) return { error: "a quote isn't closed" };
      shape.options.label = text.slice(1, end);
      text = text.slice(end + 1);
      key = null;
    } else {
      const w = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
      if (!w) return { error: `couldn't read “${text.slice(0, 12)}”` };
      const word = w[1].toLowerCase();
      text = text.slice(w[1].length);
      if (!DRAW_KEYS.has(word)) return { error: `“${w[1]}” isn't expected here` };
      if (["size", "r", "radius", "turns", "angle"].includes(word)) {
        // An expression up to the next keyword, bracket or quote
        const stop = text.search(/\s(?:at|from|to|by|of|size|r|radius|label|colour|color|turns|angle)\b|[("]/i);
        const expr = (stop < 0 ? text : text.slice(0, stop)).trim();
        if (!expr) return { error: `${word} needs a value` };
        shape.options[word === "radius" ? "r" : word] = expr;
        text = stop < 0 ? "" : text.slice(stop);
      } else if (word === "colour" || word === "color") {
        const c = /^\s*(#?[A-Za-z0-9]+)/.exec(text);
        if (!c) return { error: "colour needs a name" };
        shape.options.colour = c[1];
        text = text.slice(c[0].length);
      } else {
        key = word;
      }
    }
  }
  const need = { ground: ["from", "to"], wall: ["from", "to"], spring: ["from", "to"], damper: ["from", "to"],
    rod: ["from", "to"], string: ["from", "to"], line: ["from", "to"], block: ["at"], circle: ["at"],
    point: ["at"], pivot: ["at"], arrow: ["from"], trace: ["of"], label: ["at"] }[kind];
  for (const k of need) {
    if (!shape.points[k]) return { error: `${kind} needs “${k} (x, y)”` };
  }
  if (kind === "arrow" && !shape.points.by && !shape.points.to) return { error: "arrow needs “by (dx, dy)” or “to (x, y)”" };
  if (kind === "label" && shape.options.label == null) return { error: 'label needs text in quotes: label "m" at (x, 0)' };
  return { shape };
}

/** Every line of the model, sorted by what it is. Nothing is evaluated yet. */
export function parseModel(text) {
  const model = { title: "", equations: [], defs: [], initials: [], draws: [], view: null, stop: null, graphs: [], errors: [] };
  const err = (line, message) => model.errors.push({ line, message });
  String(text).split("\n").forEach((raw, line) => {
    const whole = raw.trim();
    if (!whole) return;
    if (whole.startsWith("#") || whole.startsWith("%")) {
      if (!model.title) model.title = whole.slice(1).trim();
      return;
    }
    // A note after the line: "k = 40 N/m   # stiffness" (a colour like #ff0000 is not one)
    const t = whole.replace(/\s+#\s.*$/, "").trim();
    if (/^draw\b/i.test(t)) {
      const { shape, error } = parseDraw(t.slice(4), line);
      if (error) err(line, error); else model.draws.push(shape);
      return;
    }
    // "stop when s >= L": the run ends the moment it holds
    if (/^stop\b/i.test(t)) {
      const cond = t.replace(/^stop\s*(when|if)?\s*/i, "").trim();
      if (!cond) err(line, "stop needs a condition:  stop when s >= L");
      else model.stop = { expr: cond, line };
      return;
    }
    // "graph v" or "graph F_s against x": the graphs a new box starts with
    if (/^graph\b/i.test(t)) {
      const g = /^graph\s+(\S+)(?:\s+(?:against|vs)\s+(\S+))?\s*$/i.exec(t);
      if (!g) err(line, "write  graph v  or  graph F against x");
      else model.graphs.push({ y: g[1], x: g[2] ?? "t", line });
      return;
    }
    if (/^view\b/i.test(t)) {
      const nums = t.slice(4).trim().split(/[\s,]+/).map(Number);
      if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) err(line, "view needs four numbers: left bottom right top");
      else model.view = nums;
      return;
    }
    const eq = splitEquals(t);
    if (!eq) return err(line, "write  name = value,  x(0) = value,  or an equation with one =");
    const [lhs, rhs] = eq;
    const init = /^([A-Za-z_][A-Za-z0-9_]*)('*)\s*\(\s*0\s*\)$/.exec(lhs);
    if (init) {
      model.initials.push({ name: init[1], order: init[2].length, expr: rhs, line });
      return;
    }
    // A plain name on the left defines a quantity, even one built from rates
    // (E = 1/2*m*x'^2); anything else with a rate in it is an equation of motion
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(lhs)) {
      model.defs.push({ name: lhs, expr: rhs, line });
      return;
    }
    if (/'/.test(t)) {
      model.equations.push({ lhs, rhs, line });
      return;
    }
    err(line, "an equation of motion needs a rate (x' or x''); to define a quantity write  name = …");
  });
  return model;
}

// ───────────────── Working it out ─────────────────

/** Solve M a = r by Gaussian elimination; null when singular. */
function solveLinear(M, r) {
  const n = r.length;
  const A = M.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < n; c++) {
    let best = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(A[i][c]) > Math.abs(A[best][c])) best = i;
    if (Math.abs(A[best][c]) < 1e-12) return null;
    [A[c], A[best]] = [A[best], A[c]];
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const f = A[i][c] / A[c][c];
      if (f) for (let j = c; j <= n; j++) A[i][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

const numberOf = (value) => {
  if (isUnit(value)) return value.toSI().toNumber();
  return typeof value === "number" ? value : NaN;
};

/** The input's unit, kept as typed when that is already SI (N/m), otherwise the SI one. */
function siUnitOf(value) {
  if (!isUnit(value)) return "";
  if (isAngle(value)) return "rad";          // the maths wants radians, whatever was typed
  const typed = unitString(value, false);
  try {
    if (Math.abs(value.toNumber(typed) - value.toSI().toNumber()) <= 1e-9 * (Math.abs(value.toSI().toNumber()) + 1)) return typed;
  } catch { /* fall through */ }
  return unitString(value.toSI());
}

/** A unit string divided by seconds `n` times, for the rates of a quantity. */
function rateUnit(base, n) {
  if (n === 0) return base;
  if (!base) return n === 1 ? "1/s" : `1/s^${n}`;
  try {
    let u = makeUnit(1, base);
    for (let i = 0; i < n; i++) u = divide(u, makeUnit(1, "s"));
    return unitString(u.toSI());
  } catch { return ""; }
}

/**
 * An expression as the unit check sees it. A comparison is a plain 1 or 0,
 * whatever it compares: "(y < 0)" with y in metres is fine to write, though
 * mathjs will not compare a length with a bare 0.
 */
const COMPARISONS = new Set(["smaller", "larger", "smallerEq", "largerEq", "equal", "unequal"]);
const forUnitCheck = (node) => node.transform((n) => (n.isOperatorNode && COMPARISONS.has(n.fn) ? new ConstantNode(1) : n));

/** Angles are numbers to the maths (sin needs none); a value in degrees becomes radians. */
const isAngle = (value) => { try { return isUnit(value) && value.equalBase(makeUnit(1, "rad")); } catch { return false; } };
/**
 * A value as the unit check sees it. Radians are a ratio, not a unit: an angle
 * is a plain number, and rad/s is 1/s — so ω/ωₙ has no unit, as it should.
 */
const forUnits = (value) => {
  if (!isUnit(value)) return value;
  if (isAngle(value)) return value.toNumber("rad");
  if (!value.units.some((u) => u.unit.base?.key === "ANGLE")) return value;
  try {
    const si = value.toSI();
    const rest = si.units.filter((u) => u.unit.base?.key !== "ANGLE");
    const number = si.toNumber();
    if (!rest.length) return number;
    const text = rest.map((u) => `${u.prefix?.name ?? ""}${u.unit.name}${u.power !== 1 ? `^${u.power}` : ""}`).join("*");
    return makeUnit(number, text);
  } catch { return value; }
};
/** value/s, n times, as an object the unit checker can multiply. */
function rateOf(value, n) {
  let u = value;
  for (let i = 0; i < n; i++) u = divide(u, makeUnit(1, "s"));
  return u;
}

function sliderRange(value, initial) {
  const a = Math.abs(value);
  if (initial) return a ? [-3 * a, 3 * a] : [-1, 1];
  if (value > 0) return [0, 4 * value];
  if (value < 0) return [4 * value, 0];
  return [0, 10];
}

/**
 * Rewrite the lines that set these inputs. The text stays the one record of
 * the model: a slider does not keep a second copy of k somewhere else.
 */
export function withParams(text, params) {
  const lines = String(text).split("\n");
  const pending = new Map(Object.entries(params));
  for (let i = 0; i < lines.length && pending.size; i++) {
    const t = lines[i].trim();
    if (!t || /^[#%]/.test(t) || /^(draw|view)\b/i.test(t)) continue;
    const eq = splitEquals(t);
    if (!eq) continue;
    const key = eq[0].replace(/\s+/g, "");
    if (!pending.has(key)) continue;
    const at = lines[i].indexOf("=");
    lines[i] = `${lines[i].slice(0, at)}= ${pending.get(key)}`;
    pending.delete(key);
  }
  for (const [key, value] of pending) lines.push(`${key} = ${value}`);
  return lines.join("\n");
}

/**
 * Turn the text into a scenario the simulation box can run: inputs, starting
 * values, equations solved for the highest rates, outputs with units, and
 * the drawing. Problems come back in `errors`, by line, and the scenario
 * still mounts so the text can be fixed in place.
 */
export function buildModelScenario(text) {
  const model = parseModel(text);
  const errors = [...model.errors];
  const err = (line, message) => errors.push({ line, message });
  const notes = [];

  // Parse every expression once
  for (const eq of model.equations) {
    const l = tryParse(eq.lhs), r = tryParse(eq.rhs);
    if (l.error) err(eq.line, l.error);
    if (r.error) err(eq.line, r.error);
    eq.lhsNode = l.node; eq.rhsNode = r.node;
  }
  for (const def of model.defs) {
    const p = tryParse(def.expr);
    if (p.error) err(def.line, p.error);
    def.node = p.node;
  }
  if (model.stop) {
    const p = tryParse(model.stop.expr);
    if (p.error) err(model.stop.line, p.error);
    model.stop.node = p.node;
  }
  for (const shape of model.draws) {
    shape.exprs = {};
    for (const [slot, [ex, ey]] of Object.entries(shape.points)) {
      const px = tryParse(ex), py = tryParse(ey);
      if (px.error || py.error) err(shape.line, px.error ?? py.error);
      shape.exprs[slot] = [px.node, py.node];
    }
    for (const opt of ["size", "r", "turns", "angle"]) {
      if (shape.options[opt] == null) continue;
      const p = tryParse(shape.options[opt]);
      if (p.error) err(shape.line, p.error);
      shape.exprs[opt] = p.node;
    }
  }

  // What moves: every name that has a rate somewhere in an equation
  const states = new Map();
  for (const eq of model.equations) {
    for (const node of [eq.lhsNode, eq.rhsNode]) {
      if (!node) continue;
      for (const s of symbolsOf(node)) {
        const { name, order } = unplain(s);
        if (order) states.set(name, Math.max(states.get(name) ?? 0, order));
      }
    }
  }
  const stateNames = [...states.keys()];
  const defNames = new Set(model.defs.map((d) => d.name));
  for (const def of model.defs) {
    if (states.has(def.name)) err(def.line, `${def.name} is set by an equation of motion, so it can't also be defined here`);
  }
  for (const ic of model.initials) {
    if (!states.has(ic.name)) err(ic.line, `${ic.name} has no equation of motion, so it has no starting value`);
    else if (ic.order >= states.get(ic.name)) err(ic.line, `${rateKey(ic.name, ic.order)} is set by the equation itself; only the lower rates start somewhere`);
  }
  if (model.equations.length && model.equations.length !== stateNames.length) {
    err(-1, `${model.equations.length} equation${model.equations.length === 1 ? "" : "s"} but ${stateNames.length} moving quantit${stateNames.length === 1 ? "y" : "ies"} (${stateNames.join(", ") || "none"}) — they must match`);
  }

  // Sort definitions: outputs follow the motion, constants follow only inputs
  const dynamic = new Set(["t", ...stateNames]);
  for (const [name, order] of states) for (let o = 1; o <= order; o++) dynamic.add(rateSym(name, o));
  const depsOf = (def) => (def.node ? symbolsOf(def.node) : []);
  const outputNames = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const def of model.defs) {
      if (outputNames.has(def.name)) continue;
      if (depsOf(def).some((s) => dynamic.has(s) || outputNames.has(s))) { outputNames.add(def.name); grew = true; }
    }
  }
  const paramDefs = [], constantDefs = [], outputDefs = [];
  for (const def of model.defs) {
    if (outputNames.has(def.name)) outputDefs.push(def);
    else if (depsOf(def).some((s) => defNames.has(s))) constantDefs.push(def);
    else paramDefs.push(def);
  }
  // Dependency order within constants and outputs
  const ordered = (list) => {
    const out = [], done = new Set(), seen = new Set();
    const visit = (def) => {
      if (done.has(def.name)) return;
      if (seen.has(def.name)) { err(def.line, `${def.name} depends on itself`); return; }
      seen.add(def.name);
      for (const s of depsOf(def)) { const d = list.find((x) => x.name === s); if (d) visit(d); }
      done.add(def.name); out.push(def);
    };
    for (const def of list) visit(def);
    return out;
  };
  const constants = ordered(constantDefs);
  const outputs = ordered(outputDefs);

  // Anything not defined: a notebook variable becomes an input, else an error
  const known = new Set([...dynamic, ...defNames]);
  const implicit = new Map();
  const checkSymbols = (node, line) => {
    if (!node) return;
    for (const s of symbolsOf(node)) {
      if (known.has(s)) continue;
      const { name, order } = unplain(s);
      if (order) err(line, `${rateKey(name, order)}: ${name} has no equation of motion, so it has no rate`);
      else if (hasVariable(name)) implicit.set(name, { name, expr: name, line: -1 });
      else err(line, `${name} isn't defined — add a line like  ${name} = 1`);
    }
  };
  for (const eq of model.equations) { checkSymbols(eq.lhsNode, eq.line); checkSymbols(eq.rhsNode, eq.line); }
  for (const def of model.defs) checkSymbols(def.node, def.line);
  for (const shape of model.draws) for (const node of Object.values(shape.exprs).flat()) checkSymbols(node, shape.line);
  if (model.stop) checkSymbols(model.stop.node, model.stop.line);
  for (const def of implicit.values()) { paramDefs.push(def); known.add(def.name); }

  // ── Inputs ──
  const params = [];
  const unitScope = { t: makeUnit(1, "s") };
  const paramUnits = {};
  for (const def of paramDefs) {
    let value;
    try { ({ value } = evaluateTyped(def.expr)); }
    catch (error) { err(def.line, `${def.name}: ${String(error.message ?? error)}`); value = 0; }
    if (value !== undefined && typeof value !== "number" && !isUnit(value)) { err(def.line, `${def.name} isn't a number`); value = 0; }
    const unit = siUnitOf(value);
    let number;
    try { number = isUnit(value) ? value.toNumber(unit) : Number(value); } catch { number = numberOf(value); }
    const [min, max] = sliderRange(number, false);
    params.push({ key: def.name, label: def.name, symbol: nameTex(def.name), unit, default: def.expr, min, max });
    paramUnits[def.name] = unit;
    unitScope[def.name] = isUnit(value) ? forUnits(value) : Number(value);
  }
  // Starting values: one input for each rate below the highest. One written
  // from the inputs ("x'(0) = v0*cos(a)") is worked out from them instead,
  // so it follows their sliders and needs none of its own.
  const stateUnits = {};
  const derivedInitials = [];
  let withConstants = null;      // the inputs and results, with units, for those
  for (const [name, order] of states) {
    for (let o = 0; o < order; o++) {
      const key = `${rateKey(name, o)}(0)`;
      const given = model.initials.find((ic) => ic.name === name && ic.order === o);
      const parsed = given ? tryParse(given.expr) : {};
      const uses = parsed.node ? symbolsOf(parsed.node).filter((sym) => defNames.has(sym)) : [];
      if (uses.length) {
        const moving = uses.find((sym) => outputNames.has(sym));
        if (moving) { err(given.line, `${key} can't depend on ${moving}, which changes as it moves`); continue; }
        if (!withConstants) {
          withConstants = { ...variableScope(), ...unitScope };
          for (const def of constants) { try { withConstants[def.name] = def.node.evaluate(withConstants); } catch { /* reported elsewhere */ } }
        }
        let value = 0;
        try { value = parsed.node.evaluate(withConstants); }
        catch (error) { err(given.line, `${key}: ${String(error.message ?? error)}`); }
        let unit = isUnit(value) ? siUnitOf(value) : "";
        if (!unit && o > 0 && stateUnits[name]) unit = rateUnit(stateUnits[name], o);
        if (o === 0) stateUnits[name] = unit;
        derivedInitials.push({ name, order: o, node: parsed.node, expr: given.expr });
        continue;
      }
      let value = 0, typed = "0";
      if (given) {
        typed = given.expr;
        try { ({ value } = evaluateTyped(given.expr)); }
        catch (error) { err(given.line, `${key}: ${String(error.message ?? error)}`); value = 0; }
      }
      let unit = isUnit(value) ? siUnitOf(value) : "";
      if (!unit && o > 0 && stateUnits[name]) unit = rateUnit(stateUnits[name], o);
      if (o === 0) stateUnits[name] = unit;
      let number;
      try { number = isUnit(value) ? value.toNumber(unit) : Number(value); } catch { number = numberOf(value); }
      const [min, max] = sliderRange(number, true);
      params.push({ key, label: o ? `starting rate of ${name}` : `starting ${name}`, symbol: `${texOf(rateSym(name, o))}(0)`,
                    unit, default: typed, min, max, initial: true, state: name, order: o });
    }
    // No unit on where it starts, but one on how fast: x'(0) in m/s makes x a length
    if (!stateUnits[name]) {
      const known = params.find((d) => d.state === name && d.order > 0 && d.unit)
        ?? null;
      const viaDerived = derivedInitials.find((d) => d.name === name && d.order > 0);
      try {
        let u = null, o = 0;
        if (known) { u = makeUnit(1, known.unit); o = known.order; }
        else if (viaDerived && withConstants) {
          const v = viaDerived.node.evaluate(withConstants);
          if (isUnit(v)) { u = v; o = viaDerived.order; }
        }
        if (u) {
          for (let i = 0; i < o; i++) u = multiply(u, makeUnit(1, "s"));
          stateUnits[name] = unitString(u.toSI());
          for (const d of params) {
            if (d.state === name && !d.unit) d.unit = d.order ? rateUnit(stateUnits[name], d.order) : stateUnits[name];
          }
        }
      } catch { /* stays without a unit */ }
    }
    // For the unit check: the quantity itself, then each rate as a value per second
    let base;
    try { base = stateUnits[name] ? forUnits(makeUnit(1, stateUnits[name])) : 1; } catch { base = 1; }
    for (let o = 0; o <= order; o++) {
      try { unitScope[rateSym(name, o)] = rateOf(base, o); } catch { unitScope[rateSym(name, o)] = 1; }
    }
  }

  // ── Units of everything else, by evaluating with units in ──
  // Worked-out quantities get the tidy name: kg·m²/s² reads as J
  // 1/s reads as Hz, except for an angular frequency (ω, omega_n, w), which reads as rad/s
  const unitOf = (v, name = "") => {
    if (!isUnit(v)) return "";
    if (isAngle(v)) return "rad";
    const u = unitString(v);
    return u === "Hz" && /^(omega|w)(_|\d|$)/i.test(name) ? "rad/s" : u;
  };
  const defUnits = {};
  const hasUnits = Object.values(paramUnits).some(Boolean) || Object.values(stateUnits).some(Boolean);
  for (const def of [...constants, ...outputs]) {
    try {
      const v = forUnitCheck(def.node).evaluate({ ...variableScope(), ...unitScope });
      unitScope[def.name] = v;
      defUnits[def.name] = unitOf(v, def.name);
    } catch { defUnits[def.name] = ""; }
  }
  if (hasUnits) {
    for (const eq of model.equations) {
      if (!eq.lhsNode || !eq.rhsNode) continue;
      let l, r;
      try { l = forUnitCheck(eq.lhsNode).evaluate({ ...variableScope(), ...unitScope }); } catch (error) { notes.push({ line: eq.line, bad: true, text: `left side: ${String(error.message ?? error)}` }); continue; }
      try { r = forUnitCheck(eq.rhsNode).evaluate({ ...variableScope(), ...unitScope }); } catch (error) { notes.push({ line: eq.line, bad: true, text: `right side: ${String(error.message ?? error)}` }); continue; }
      const lu = unitOf(l), ru = unitOf(r);
      if (isUnit(l) && isUnit(r)) {
        if (l.equalBase(r)) notes.push({ line: eq.line, text: `both sides in ${lu}` });
        else notes.push({ line: eq.line, bad: true, text: `left side in ${lu}, right side in ${ru} — they should agree` });
      } else if (isUnit(l) !== isUnit(r)) {
        // Plain zero on one side is the usual "= 0", and fine
        const plainSide = isUnit(l) ? r : l;
        if (plainSide !== 0) notes.push({ line: eq.line, bad: true, text: `${isUnit(l) ? "right" : "left"} side has no units, the other is in ${lu || ru}` });
      }
    }
  }

  // ── Numbers: compile and solve ──
  const layout = [];
  let offset = 0;
  for (const [name, order] of states) { layout.push({ name, order, offset }); offset += order; }
  const unknowns = layout.map(({ name, order }) => rateSym(name, order));
  const compiled = (node) => { try { return node?.compile(); } catch { return null; } };
  const residuals = model.equations.map((eq) => {
    if (!eq.lhsNode || !eq.rhsNode) return null;
    try { return parse(`(${plain(lockUnits(eq.lhs))}) - (${plain(lockUnits(eq.rhs))})`).compile(); }
    catch { return null; }
  });
  for (const def of [...constants, ...outputs]) def.code = compiled(def.node);
  for (const shape of model.draws) {
    shape.code = {};
    for (const [slot, pair] of Object.entries(shape.exprs)) {
      shape.code[slot] = Array.isArray(pair) ? pair.map(compiled) : compiled(pair);
    }
  }
  const stopCode = compiled(model.stop?.node);
  const broken = errors.length > 0 || residuals.some((r) => !r) || !model.equations.length;
  const evalNumber = (code, scope) => { try { return numberOf(code.evaluate(scope)); } catch { return NaN; } };
  const evalDefs = (scope, list) => { for (const def of list) scope[def.name] = def.code ? evalNumber(def.code, scope) : NaN; };
  const base = variableScope();
  const fill = (scope, t, y, p) => {
    Object.assign(scope, base, p);
    scope.t = t;
    for (const { name, order, offset: at } of layout) {
      for (let o = 0; o < order; o++) scope[rateSym(name, o)] = y[at + o];
    }
    evalDefs(scope, constants);
  };
  const residualsAt = (scope, a) => {
    for (let j = 0; j < unknowns.length; j++) scope[unknowns[j]] = a[j];
    evalDefs(scope, outputs);
    return residuals.map((code) => (code ? evalNumber(code, scope) : NaN));
  };
  let failed = null;
  /** Solve the equations for the highest rates, given everything else. */
  const solve = (scope) => {
    const n = unknowns.length;
    const zero = new Array(n).fill(0);
    const b = residualsAt(scope, zero);
    const M = b.map(() => new Array(n));
    for (let j = 0; j < n; j++) {
      const e = zero.slice(); e[j] = 1;
      const r = residualsAt(scope, e);
      for (let i = 0; i < n; i++) M[i][j] = r[i] - b[i];
    }
    const a = n ? solveLinear(M, b.map((v) => -v)) : [];
    if (!a || a.some((v) => !Number.isFinite(v))) {
      failed ??= "the equations can't be solved for " + unknowns.map((s) => rateKey(unplain(s).name, unplain(s).order)).join(", ");
      return zero;
    }
    for (let j = 0; j < n; j++) scope[unknowns[j]] = a[j];
    evalDefs(scope, outputs);
    return a;
  };

  // The whole picture at one instant, worked out once per instant
  let memo = { t: NaN, y: null, p: null, scope: null };
  const frame = (t, y, p) => {
    if (memo.t === t && memo.y === y && memo.p === p) return memo.scope;
    const scope = {};
    fill(scope, t, y, p);
    if (!broken) solve(scope);
    memo = { t, y, p, scope };
    return scope;
  };

  const paramKeys = params.map((d) => d.key);
  for (const d of derivedInitials) d.code = compiled(d.node);
  const initial = (p) => {
    const y = new Array(offset).fill(0);
    for (const d of params) if (d.initial) y[layout.find((l) => l.name === d.state).offset + d.order] = p[d.key] ?? 0;
    if (derivedInitials.length) {
      const scope = { ...base, ...p };
      evalDefs(scope, constants);
      for (const d of derivedInitials) {
        y[layout.find((l) => l.name === d.name).offset + d.order] = d.code ? evalNumber(d.code, scope) : 0;
      }
    }
    return y;
  };
  const derivative = (t, y, p) => {
    const dy = new Array(y.length).fill(0);
    if (broken) return dy;
    const scope = frame(t, y, p);
    for (let j = 0; j < layout.length; j++) {
      const { name, order, offset: at } = layout[j];
      for (let o = 0; o < order - 1; o++) dy[at + o] = y[at + o + 1];
      dy[at + order - 1] = scope[unknowns[j]];
    }
    return dy;
  };

  // A first solve, to report an unsolvable set-up before anything runs
  if (!broken) {
    const p = {};
    for (const d of params) {
      try { const { value } = evaluateTyped(d.default); p[d.key] = isUnit(value) ? value.toNumber(d.unit) : Number(value); }
      catch { p[d.key] = 0; }
    }
    const y = initial(p);
    const scope = {};
    fill(scope, 0, y, p);
    const a = solve(scope);
    if (failed) err(-1, failed);
    else {
      // Linear in the highest rates? Twice the rate must give twice the change.
      const n = unknowns.length;
      const r0 = residualsAt(scope, new Array(n).fill(0));
      for (let j = 0; j < n && !failed; j++) {
        const e1 = new Array(n).fill(0), e2 = new Array(n).fill(0);
        e1[j] = 1; e2[j] = 2;
        const r1 = residualsAt(scope, e1), r2 = residualsAt(scope, e2);
        for (let i = 0; i < n; i++) {
          const scale = Math.abs(r0[i]) + Math.abs(r1[i]) + 1e-9;
          if (Math.abs((r2[i] - r0[i]) - 2 * (r1[i] - r0[i])) > 1e-6 * scale) {
            const u = unplain(unknowns[j]);
            err(model.equations[i].line, `not linear in ${rateKey(u.name, u.order)} — ntbk can only solve equations where the highest rate appears on its own, times things`);
            failed = true;
          }
        }
      }
      void a;
    }
  }

  // ── Outputs ──
  const outputsSpec = {};
  for (const [name, order] of states) {
    for (let o = 0; o <= order; o++) {
      const sym = rateSym(name, o);
      outputsSpec[rateKey(name, o)] = {
        label: rateKey(name, o), symbol: texOf(sym), unit: rateUnit(stateUnits[name] ?? "", o),
        get: (t, y, p) => frame(t, y, p)[sym],
      };
    }
  }
  for (const def of outputs) {
    outputsSpec[def.name] = { label: def.name, symbol: nameTex(def.name), unit: defUnits[def.name] ?? "",
                              get: (t, y, p) => frame(t, y, p)[def.name] };
  }

  // Graphs asked for by name must be things that exist
  const graphKeys = new Set(["t", ...Object.keys(outputsSpec)]);
  const asked = [];
  for (const g of model.graphs) {
    const bad = [g.y, g.x].find((k) => !graphKeys.has(k));
    if (bad) err(g.line, `${bad} isn't a quantity of this model — graph one of: ${[...graphKeys].join(", ")}`);
    else asked.push({ x: g.x, y: g.y });
  }
  const graphs = [...asked];
  for (const [name, order] of states) {
    graphs.push({ x: "t", y: name });
    if (order >= 2) graphs.push({ x: name, y: rateKey(name, 1), label: `Phase  ${name}'–${name}` });
  }
  for (const def of outputs.slice(0, 3)) graphs.push({ x: "t", y: def.name });
  // The quick choices once each, those asked for first
  const quick = graphs.filter((g, i) => graphs.findIndex((h) => h.x === g.x && h.y === g.y) === i);

  // ── Typeset ──
  const stopTex = model.stop?.node ? `\\text{stops when }${nodeTex(model.stop.node)}` : "";
  const equationsTex = model.equations.map((eq) =>
    (eq.lhsNode && eq.rhsNode ? `${nodeTex(eq.lhsNode)} = ${nodeTex(eq.rhsNode)}` : `\\text{${eq.lhs} = ${eq.rhs}}`));
  const defsTex = [...constants, ...outputs].map((def) =>
    (def.node ? `${nameTex(def.name)} = ${nodeTex(def.node)}` : ""));

  const readouts = (p) => constants.map((def) => {
    const scope = { ...base, ...p };
    evalDefs(scope, constants);
    return { symbol: nameTex(def.name), value: scope[def.name], unit: defUnits[def.name] ?? "" };
  });

  // ── Drawing ──
  const stages = new WeakMap();
  const shapesAt = (scope) => model.draws.map((shape) => {
    const out = { kind: shape.kind, colour: shape.options.colour, label: shape.options.label, index: shape.line };
    for (const [slot, code] of Object.entries(shape.code)) {
      out[slot] = Array.isArray(code) ? code.map((c) => (c ? evalNumber(c, scope) : NaN)) : (code ? evalNumber(code, scope) : NaN);
    }
    return out;
  });
  const render = (svg, run, ghost) => {
    let stage = stages.get(svg);
    if (!stage) { stage = new SvgStage(svg); stages.set(svg, stage); }
    if (broken) return stage.message(errors.length ? "Fix the model in the Edit panel" : "Write equations in the Edit panel");
    if (failed && typeof failed === "string") return stage.message(failed);
    const main = shapesAt(frame(run.t, run.y, run.params));
    const other = ghost ? shapesAt(frame(ghost.t, ghost.y, ghost.params)) : null;
    stage.frame(main, other, run.t, model.view);
  };

  // What a rebuild cares about: everything but the inputs' values
  const signature = JSON.stringify({
    eq: model.equations.map((e) => [e.lhs, e.rhs]),
    defs: model.defs.map((d) => [d.name, paramDefs.includes(d) ? "" : d.expr]),
    keys: paramKeys, units: params.map((d) => d.unit),
    draws: model.draws.map((d) => [d.kind, d.points, d.options]),
    view: model.view, title: model.title, errors: errors.length, stop: model.stop?.expr ?? null,
    graphs: model.graphs.map((g) => [g.x, g.y]),
    derived: derivedInitials.map((d) => [d.name, d.order, d.expr]),
  });

  return {
    id: "model", title: model.title || "Model", category: "Your own",
    summary: "Written as equations",
    custom: true, text: String(text), signature, errors, notes,
    params, equations: [...equationsTex, ...defsTex.filter(Boolean), ...(stopTex ? [stopTex] : [])],
    initial, derivative, outputs: outputsSpec,
    stop: stopCode && !broken ? (t, y, p) => {
      try { const v = stopCode.evaluate(frame(t, y, p)); return v === true || (typeof v === "number" && v !== 0); }
      catch { return false; }
    } : undefined,
    // The first three asked for open with the box; the rest are a click away
    plots: asked.length ? asked.slice(0, 3) : stateNames.map((name) => ({ x: "t", y: name })),
    graphs: quick, readouts, render,
    unitTex,
  };
}
