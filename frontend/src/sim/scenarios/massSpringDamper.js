import { palette, prepare, spring, damper, ground, arrow, label, scaleBar } from "../draw.js";

// ─────────────────────────────────────────────
//  MASS–SPRING–DAMPER
//
//    m x'' + c x' + k x = F0 cos(ωd t)
//
//  The foundation's proving case: two states,
//  a closed-form check (ω_n, ζ), and every kind
//  of control — a stiffness changed while it
//  runs, a starting displacement that only
//  applies on reset, and a driving force that
//  shows resonance.
// ─────────────────────────────────────────────
export default {
  id: "mass-spring-damper",
  title: "Mass–spring–damper",
  category: "Mechanical",
  summary: "A block on a spring with a damper, free or driven",
  // Now an editable model (sim/model.js EXAMPLES); this one only opens old notebooks
  hidden: true,

  params: [
    { key: "m", label: "Mass", symbol: "m", unit: "kg", default: "1 kg", min: 0.1, max: 10, positive: true },
    { key: "k", label: "Stiffness", symbol: "k", unit: "N/m", default: "40 N/m", min: 1, max: 400, positive: true },
    { key: "c", label: "Damping", symbol: "c", unit: "N*s/m", default: "0.8 N*s/m", min: 0, max: 40 },
    { key: "F0", label: "Driving force", symbol: "F_0", unit: "N", default: "0 N", min: 0, max: 20 },
    { key: "wd", label: "Driving frequency", symbol: "\\omega_d", unit: "rad/s", default: "6 rad/s", min: 0, max: 30 },
    { key: "x0", label: "Start position", symbol: "x_0", unit: "m", default: "0.2 m", min: -0.5, max: 0.5, initial: true },
    { key: "v0", label: "Start velocity", symbol: "v_0", unit: "m/s", default: "0 m/s", min: -3, max: 3, initial: true },
  ],

  equations: [
    "m\\ddot{x} + c\\dot{x} + kx = F_0\\cos(\\omega_d t)",
    "\\omega_n = \\sqrt{k/m},\\quad \\zeta = \\dfrac{c}{2\\sqrt{km}}",
  ],

  initial: (p) => [p.x0, p.v0],

  derivative: (t, [x, v], p) => [v, (p.F0 * Math.cos(p.wd * t) - p.c * v - p.k * x) / p.m],

  outputs: {
    x: { label: "Displacement", symbol: "x", unit: "m", get: (t, y) => y[0] },
    v: { label: "Velocity", symbol: "v", unit: "m/s", get: (t, y) => y[1] },
    a: { label: "Acceleration", symbol: "a", unit: "m/s^2",
         get: (t, [x, v], p) => (p.F0 * Math.cos(p.wd * t) - p.c * v - p.k * x) / p.m },
    Fs: { label: "Spring force", symbol: "F_s", unit: "N", get: (t, [x], p) => -p.k * x },
    Fd: { label: "Damper force", symbol: "F_d", unit: "N", get: (t, [, v], p) => -p.c * v },
    F: { label: "Driving force", symbol: "F", unit: "N", get: (t, y, p) => p.F0 * Math.cos(p.wd * t) },
    T: { label: "Kinetic energy", symbol: "T", unit: "J", get: (t, [, v], p) => 0.5 * p.m * v * v },
    U: { label: "Spring energy", symbol: "U", unit: "J", get: (t, [x], p) => 0.5 * p.k * x * x },
    E: { label: "Total energy", symbol: "E", unit: "J",
         get: (t, [x, v], p) => 0.5 * p.m * v * v + 0.5 * p.k * x * x },
  },

  // Displacement, velocity and acceleration, as three linked graphs
  plots: [{ x: "t", y: "x" }, { x: "t", y: "v" }, { x: "t", y: "a" }],

  // One click away in the graph chooser; anything against anything is still
  // possible from the axis menus
  graphs: [
    { x: "t", y: "x" }, { x: "t", y: "v" }, { x: "t", y: "a" },
    { x: "x", y: "v", label: "Phase  v–x" },
    { x: "t", y: "E" }, { x: "x", y: "Fs", label: "Spring  F–x" },
  ],

  /** Worked from the parameters, not the run: what the theory predicts. */
  readouts(p) {
    const wn = Math.sqrt(p.k / p.m);
    const zeta = p.c / (2 * Math.sqrt(p.k * p.m));
    const regime = zeta === 0 ? "undamped" : zeta < 1 ? "underdamped"
      : Math.abs(zeta - 1) < 1e-3 ? "critically damped" : "overdamped";
    const out = [
      { symbol: "\\omega_n", value: wn, unit: "rad/s" },
      { symbol: "f_n", value: wn / (2 * Math.PI), unit: "Hz" },
      { symbol: "T_n", value: (2 * Math.PI) / wn, unit: "s" },
      { symbol: "\\zeta", value: zeta, unit: "", note: regime },
    ];
    if (zeta < 1) out.push({ symbol: "\\omega_d^{\\,free}", value: wn * Math.sqrt(1 - zeta * zeta), unit: "rad/s" });
    if (p.F0 > 0 && p.wd > 0) {
      const r = p.wd / wn;
      const X = (p.F0 / p.k) / Math.sqrt((1 - r * r) ** 2 + (2 * zeta * r) ** 2);
      out.push({ symbol: "X_{steady}", value: X, unit: "m" });
    }
    return out;
  },

  draw(canvas, run) {
    const { ctx, w, h } = prepare(canvas);
    const c = palette();
    const p = run.params;
    const [x, v] = run.y;
    // Enough room for the start position, the static deflection from the
    // driving force, and the steady swing near resonance
    const reach = Math.max(Math.abs(p.x0) * 1.3, (p.F0 / p.k) * 3, Math.abs(x) * 1.1, 0.05);
    const wallX = 26;
    const rest = wallX + (w - wallX) * 0.5;
    const perMetre = ((w - wallX) * 0.38) / reach;
    const block = Math.min(70, h * 0.32);
    const cy = h * 0.48;
    const bx = rest + x * perMetre;

    ctx.lineWidth = 1.6;
    ctx.strokeStyle = c.ink;
    ctx.fillStyle = c.ink;
    ground(ctx, wallX, cy - block * 0.9, wallX, cy + block * 0.9, { side: -1 });
    ground(ctx, wallX, cy + block / 2 + 1, w - 10, cy + block / 2 + 1, { side: 1 });

    // Equilibrium
    ctx.save();
    ctx.strokeStyle = c.dim;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(rest, cy - block * 0.85); ctx.lineTo(rest, cy + block / 2); ctx.stroke();
    ctx.restore();
    label(ctx, "x = 0", rest, cy - block * 0.95, { size: 10, colour: c.dim });

    ctx.strokeStyle = c.ink;
    spring(ctx, wallX, cy - block * 0.2, bx - block / 2, cy - block * 0.2,
           { turns: 9, width: Math.min(16, block * 0.25) });
    if (p.c > 0) damper(ctx, wallX, bx - block / 2, cy + block * 0.25, { size: Math.min(14, block * 0.22) });

    // The block
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.16;
    ctx.fillRect(bx - block / 2, cy - block / 2, block, block);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.accent;
    ctx.strokeRect(bx - block / 2, cy - block / 2, block, block);
    label(ctx, "m", bx, cy, { size: 14, colour: c.accent, weight: 600 });

    // Velocity arrow above the block
    ctx.strokeStyle = c.good; ctx.fillStyle = c.good; ctx.lineWidth = 2;
    arrow(ctx, bx, cy - block / 2 - 12, bx + Math.max(-90, Math.min(90, v * perMetre * 0.25)), cy - block / 2 - 12);

    // Driving force on the block
    if (p.F0 > 0) {
      const F = p.F0 * Math.cos(p.wd * run.t);
      ctx.strokeStyle = c.warm; ctx.fillStyle = c.warm;
      arrow(ctx, bx + block / 2, cy, bx + block / 2 + (F / p.F0) * 40, cy);
    }
    scaleBar(ctx, perMetre, w - 110, h - 12, c.dim);
  },
};
