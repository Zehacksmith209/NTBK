import { isUnit } from "mathjs";
import { evaluateTyped, namesUsed } from "./variables.js";

// ─────────────────────────────────────────────
//  SIMULATION ENGINE
//
//  A scenario is the model: its parameters,
//  its equations of motion, what it measures,
//  and how it is drawn. This file runs one.
//
//  Two kinds of scenario:
//  - an ODE: `derivative(t, y, p)` gives dy/dt
//    and the engine integrates it (RK4, fixed
//    step), which covers springs, pendulums,
//    projectiles and oscillators;
//  - its own stepper: `create(p)` returns an
//    object with step(dt), used when another
//    engine (Rapier for collisions) owns the
//    physics.
//
//  Everything inside is plain SI numbers. Units
//  live at the edges: what was typed is turned
//  into SI here, and readouts are given units
//  again when shown.
// ─────────────────────────────────────────────

/** One classical Runge–Kutta step. */
export function rk4(f, t, y, dt, p) {
  const n = y.length;
  const k1 = f(t, y, p);
  const y2 = new Array(n), y3 = new Array(n), y4 = new Array(n);
  for (let i = 0; i < n; i++) y2[i] = y[i] + (dt / 2) * k1[i];
  const k2 = f(t + dt / 2, y2, p);
  for (let i = 0; i < n; i++) y3[i] = y[i] + (dt / 2) * k2[i];
  const k3 = f(t + dt / 2, y3, p);
  for (let i = 0; i < n; i++) y4[i] = y[i] + dt * k3[i];
  const k4 = f(t + dt, y4, p);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = y[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  return out;
}

/**
 * Turn what was typed for each parameter into an SI number.
 *
 * A parameter can be a number ("20", taken in the parameter's own unit),
 * a value with a unit ("20 N/m", converted), or anything using the
 * notebook's variables ("k", "2*k"). A unit of the wrong kind is refused
 * rather than converted into nonsense: a mass typed into a stiffness says so.
 */
export function resolveParams(scenario, typed = {}) {
  const values = {}, errors = {}, links = {};
  for (const def of scenario.params) {
    const text = String(typed[def.key] ?? def.default ?? "").trim();
    links[def.key] = namesUsed(text);
    let value;
    try {
      ({ value } = evaluateTyped(text || "0"));
    } catch (error) {
      errors[def.key] = String(error.message ?? error).replace(/^Error:\s*/, "");
      value = undefined;
    }
    if (value !== undefined && isUnit(value)) {
      try {
        value = def.unit ? value.toNumber(def.unit) : value.toSI().toNumber();
      } catch {
        errors[def.key] = `needs ${def.unit ? `a value in ${def.unit}` : "a plain number"}`;
        value = undefined;
      }
    } else if (value !== undefined && typeof value !== "number") {
      errors[def.key] = "not a number";
      value = undefined;
    }
    if (value === undefined || !Number.isFinite(value)) {
      if (!errors[def.key]) errors[def.key] = "not a number";
      value = def.fallback ?? Number(String(def.default).split(" ")[0]) ?? 0;
    }
    if (def.positive && value <= 0) {
      errors[def.key] = "must be more than zero";
      value = Number(String(def.default).split(" ")[0]) || 1;
    }
    values[def.key] = value;
  }
  return { values, errors, links };
}

/**
 * Wrap an ODE scenario so it steps the same way as one with its own engine.
 */
function odeStepper(scenario, p) {
  let y = scenario.initial(p);
  return {
    get y() { return y; },
    set y(next) { y = [...next]; },
    step(t, dt, params) { y = rk4(scenario.derivative, t, y, dt, params); },
    reset(params) { y = scenario.initial(params); },
  };
}

/**
 * One run: time, state, and the history of every output it measures.
 *
 * Real time drives it (requestAnimationFrame), scaled by `speed`, and it
 * always advances in whole steps of `dt`, so the answer does not depend on
 * how fast the computer draws.
 */
export class Run {
  constructor(scenario, params, { dt = 0.002, keep = 60000 } = {}) {
    this.scenario = scenario;
    this.params = params;
    this.dt = dt;
    this.keep = keep;
    this.t = 0;
    this.stepper = scenario.create ? scenario.create(params) : odeStepper(scenario, params);
    this.history = { t: [] };
    for (const key of Object.keys(scenario.outputs)) this.history[key] = [];
    this.record();
  }

  get y() { return this.stepper.y; }

  /** Measure every output now and add it to the history. */
  record() {
    const out = this.measure();
    this.history.t.push(this.t);
    for (const key of Object.keys(this.scenario.outputs)) this.history[key].push(out[key]);
    if (this.history.t.length > this.keep) {
      for (const series of Object.values(this.history)) series.splice(0, series.length - this.keep);
    }
  }

  measure() {
    const out = {};
    for (const [key, def] of Object.entries(this.scenario.outputs)) {
      out[key] = def.get(this.t, this.stepper.y, this.params, this.stepper);
    }
    return out;
  }

  /**
   * Advance by `seconds` of simulated time. Recorded about every
   * `recordEvery` seconds rather than every step, which keeps a long run's
   * history and the graphs drawn from it a sensible size.
   */
  advance(seconds, recordEvery = 1 / 120) {
    let left = seconds;
    let sinceRecord = 0;
    while (left > 1e-12) {
      const dt = Math.min(this.dt, left);
      this.stepper.step(this.t, dt, this.params);
      this.t += dt;
      left -= dt;
      sinceRecord += dt;
      if (this.scenario.stop?.(this.t, this.stepper.y, this.params)) {
        this.record();
        return false;
      }
      if (sinceRecord >= recordEvery) { this.record(); sinceRecord = 0; }
    }
    return true;
  }

  /** Back to the start, with the initial conditions as they are now. */
  reset(params = this.params) {
    this.params = params;
    this.t = 0;
    this.stepper.reset ? this.stepper.reset(params) : (this.stepper = this.scenario.create(params));
    for (const series of Object.values(this.history)) series.length = 0;
    this.record();
  }

  /** The moment as data, so it can be saved in the notebook and resumed. */
  snapshot() {
    return { t: this.t, y: [...(this.stepper.y ?? [])] };
  }

  /**
   * Go back to a saved moment. The graph keeps whatever this run had
   * already recorded up to then, so going back in time does not wipe the
   * picture of how it got there.
   */
  restore(moment) {
    if (!moment || !this.stepper.y) return false;
    let keep = 0;
    while (keep < this.history.t.length && this.history.t[keep] < moment.t - 1e-9) keep++;
    for (const series of Object.values(this.history)) series.length = keep;
    this.t = moment.t;
    this.stepper.y = moment.y;
    this.record();
    return true;
  }

  /** Every recorded sample as CSV, with units in the header. */
  toCSV() {
    const keys = Object.keys(this.scenario.outputs);
    const head = ["t (s)", ...keys.map((k) => {
      const def = this.scenario.outputs[k];
      return def.unit ? `${def.label ?? k} (${def.unit})` : (def.label ?? k);
    })];
    const rows = [head.map((h) => `"${h.replace(/"/g, '""')}"`).join(",")];
    for (let i = 0; i < this.history.t.length; i++) {
      rows.push([this.history.t[i], ...keys.map((k) => this.history[k][i])]
        .map((v) => (Number.isFinite(v) ? +v.toPrecision(10) : "")).join(","));
    }
    return rows.join("\n");
  }
}
