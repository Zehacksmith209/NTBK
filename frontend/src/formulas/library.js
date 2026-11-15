import { parse, evaluate, format } from "mathjs";
import { bridge } from "../bridge.js";
import { newId } from "../model/ids.js";

// ─────────────────────────────────────────────
//  FORMULA LIBRARY
//
//  The student's own formulas, kept outside any
//  one notebook so they follow the person rather
//  than the file.
//
//  A formula can be held two ways, and usually
//  both:
//
//    latex  how it is WRITTEN. This is what goes
//           on the page.
//    calc   how it is WORKED OUT, in the form
//           f(x) = x^2 + 1. This is what lets
//           the library take numbers and give
//           an answer back.
//
//  LaTeX cannot be turned into something that
//  computes — it describes ink, not arithmetic —
//  but the reverse works, so a formula entered
//  only in its calculable form gets its LaTeX
//  written for it.
// ─────────────────────────────────────────────

const GREEK = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
  "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
  "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi",
  "Psi", "Omega",
]);

// Names that already mean a number. Anything else in a formula is something
// the student has to supply. Deliberately short: mathjs also knows every unit
// name, so "m" would otherwise count as "metre" and never be asked for.
const CONSTANTS = new Set(["pi", "tau", "e", "phi", "Infinity"]);

/** A variable name as LaTeX: x_1, g_earth and theta all read properly. */
export function symbolTex(name) {
  const [base, ...rest] = String(name).split("_");
  const word = (text) => (GREEK.has(text) ? `\\${text}`
    : text.length > 1 ? `\\mathrm{${text}}` : text);
  if (!rest.length) return word(base);
  const sub = rest.join("\\_");
  return `${word(base)}_{${/^[\d]+$/.test(sub) || sub.length === 1 ? sub : `\\mathrm{${sub}}`}}`;
}

const texOptions = {
  parenthesis: "auto",
  // mathjs prints a symbol that happens to be a unit name upright — m, b, t —
  // and escapes underscores instead of setting a subscript. Variables are
  // handled here; everything else is left to it.
  //
  // The leading space matters: mathjs writes "\\cdot" straight before the next
  // symbol, and "\\cdotx" is an unknown command where "\\cdot x" is a product.
  handler: (node) => (node.isSymbolNode ? ` ${symbolTex(node.name)}` : undefined),
};

/**
 * Read "f(x) = x^2 + 1".
 *
 * The left side names the result and, in brackets, the values it is a
 * function of. Any other name on the right that is not a known constant is
 * also asked for, so g_earth(r) = G*M/r^2 asks for r, then G, then M.
 */
export function parseDefinition(text) {
  const source = String(text ?? "").trim();
  if (!source) return { ok: false, error: "empty" };

  // The first "=" that is not part of ==, <=, >= or != splits the two sides
  const at = source.search(/(?<![=<>!])=(?!=)/);
  const left = at < 0 ? "" : source.slice(0, at).trim();
  const right = at < 0 ? source : source.slice(at + 1).trim();
  if (!right) return { ok: false, error: "Nothing after the = sign" };

  let name = "result";
  let args = [];
  if (left) {
    const head = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^()]*)\))?$/.exec(left);
    if (!head) return { ok: false, error: "The left side should look like f(x) or F" };
    name = head[1];
    args = (head[2] ?? "").split(",").map((a) => a.trim()).filter(Boolean);
    const bad = args.find((a) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a));
    if (bad) return { ok: false, error: `"${bad}" is not a variable name` };
  }

  let node;
  try {
    node = parse(right);
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }

  const inputs = [...args];
  node.traverse((n, path, parent) => {
    if (!n.isSymbolNode) return;
    if (parent?.isFunctionNode && path === "fn") return;     // sin, sqrt, log
    if (CONSTANTS.has(n.name) || inputs.includes(n.name)) return;
    inputs.push(n.name);
  });

  return { ok: true, name, args, inputs, node, code: node.compile(), hasLeft: !!left };
}

/** The whole definition as LaTeX, for a formula entered only in calculable form. */
export function definitionTex(definition) {
  const right = definition.node.toTex(texOptions);
  if (!definition.hasLeft) return right;
  const left = definition.args.length
    ? `${symbolTex(definition.name)}\\left(${definition.args.map(symbolTex).join(", ")}\\right)`
    : symbolTex(definition.name);
  return `${left} = ${right}`;
}

/** A number, or a number with a unit, as LaTeX. */
function valueTex(text) {
  const match = /^(-?\d+(?:\.\d+)?)(?:e([+-]?\d+))?\s*(.*)$/.exec(text);
  if (!match) return `\\text{${text}}`;
  const [, mantissa, exponent, unit] = match;
  const number = exponent ? `${mantissa} \\times 10^{${Number(exponent)}}` : mantissa;
  return unit ? `${number}\\,\\mathrm{${unit.replace(/\s+/g, "\\,")}}` : number;
}

/**
 * Work a definition out for the values given.
 *
 * `values` maps each input name to what was typed for it, which may itself
 * be an expression ("2*pi") or carry a unit ("3 m/s^2").
 */
export function calculate(definition, values) {
  const scope = {};
  const missing = [];
  for (const name of definition.inputs) {
    const typed = String(values?.[name] ?? "").trim();
    if (!typed) { missing.push(name); continue; }
    try {
      const value = evaluate(typed);
      if (value === undefined || typeof value === "function") throw new Error("not a value");
      scope[name] = value;
    } catch {
      return { ok: false, error: `"${typed}" is not a value for ${name}` };
    }
  }
  if (missing.length) return { ok: false, missing };

  let result;
  try {
    result = definition.code.evaluate(scope);
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
  if (typeof result === "number" && !Number.isFinite(result)) {
    return { ok: false, error: Number.isNaN(result) ? "Not defined for these values" : "Infinite" };
  }

  const text = format(result, { precision: 10 });
  const shown = (name) => valueTex(format(scope[name], { precision: 10 }));
  const left = definition.args.length
    ? `${symbolTex(definition.name)}\\left(${definition.args.map(shown).join(", ")}\\right)`
    : symbolTex(definition.name);
  return { ok: true, text, tex: `${left} = ${valueTex(text)}` };
}

// ── Storage ─────────────────────────────────

/** Shown the first time, so it is obvious what a formula with both forms does. */
const STARTERS = [
  { name: "Quadratic formula", category: "Examples",
    latex: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
    calc: "x_plus(a, b, c) = (-b + sqrt(b^2 - 4*a*c)) / (2*a)" },
  { name: "Newton's second law", category: "Examples",
    latex: "F = ma", calc: "F(m, a) = m*a" },
  { name: "Kinetic energy", category: "Examples",
    latex: "E_k = \\tfrac{1}{2} m v^2", calc: "E_k(m, v) = 1/2*m*v^2" },
];

export function createFormula(fields = {}) {
  return { id: newId("fm"), name: "", category: "", latex: "", calc: "", ...fields };
}

export async function loadFormulas() {
  const raw = await bridge.getFormulas();
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data?.formulas)) return data.formulas;
    } catch { /* an unreadable file is treated as an empty library */ }
    return [];
  }
  return STARTERS.map((starter) => createFormula(starter));
}

export function saveFormulas(formulas) {
  return bridge.saveFormulas(JSON.stringify({ version: 1, formulas }, null, 1));
}
