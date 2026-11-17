import { palette } from "./draw.js";

// ─────────────────────────────────────────────
//  SVG STAGE
//
//  The picture of a simulation, drawn as shapes
//  rather than pixels, so it stays sharp at any
//  zoom and can later be dragged. Each frame is
//  built as markup from a list of shapes in
//  model units (metres), fitted to the box.
// ─────────────────────────────────────────────
const NS = "http://www.w3.org/2000/svg";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (v) => (Number.isFinite(v) ? +v.toFixed(2) : 0);

export class SvgStage {
  constructor(svg) {
    this.svg = svg;
    svg.setAttribute("xmlns", NS);
    this.traces = new Map();
    this.extent = null;
    this.lastT = -1;
  }

  message(text) {
    const w = this.svg.clientWidth || 300, h = this.svg.clientHeight || 150;
    const c = palette();
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle"
      font-family="${esc(c.font)}" font-size="12" fill="${c.dim}">${esc(text)}</text>`;
  }

  /** Draw one instant: the shapes of the run, and faintly those of a comparison. */
  frame(shapes, ghost, t, fixedView) {
    const w = this.svg.clientWidth || 300, h = this.svg.clientHeight || 150;
    const c = palette();
    // A reset: the trails start again, and the view fits the drawing afresh
    if (t < this.lastT) { this.traces.clear(); this.extent = null; }
    this.lastT = t;

    const all = ghost ? [...shapes, ...ghost] : shapes;
    if (all.some((s) => [s.at, s.from, s.to, s.by, s.of].flat().some((v) => v !== undefined && !Number.isFinite(v)))) {
      return this.message(`the equations gave no answer at t = ${t.toFixed(2)} s`);
    }

    // What has to fit: the view only ever grows, so it does not wobble
    const box = fixedView ? { x0: fixedView[0], y0: fixedView[1], x1: fixedView[2], y1: fixedView[3] } : this.extent ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    if (!fixedView) {
      const grow = (x, y) => {
        if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x;
        if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
      };
      for (const s of all) {
        for (const key of ["at", "from", "to", "of"]) if (s[key]) grow(s[key][0], s[key][1]);
        if (s.kind === "arrow" && s.by) grow(s.from[0] + s.by[0], s.from[1] + s.by[1]);
        if (s.kind === "block" && s.at) { const half = (s.size ?? 0) / 2; grow(s.at[0] - half, s.at[1] - half); grow(s.at[0] + half, s.at[1] + half); }
        if (s.kind === "circle" && s.at) { const r = s.r ?? 0; grow(s.at[0] - r, s.at[1] - r); grow(s.at[0] + r, s.at[1] + r); }
      }
      if (!Number.isFinite(box.x0)) Object.assign(box, { x0: -1, y0: -1, x1: 1, y1: 1 });
      // Never a zero-size view
      if (box.x1 - box.x0 < 1e-6) { box.x0 -= 0.5; box.x1 += 0.5; }
      if (box.y1 - box.y0 < 1e-6) { box.y0 -= 0.5; box.y1 += 0.5; }
      this.extent = box;
    }
    const margin = 0.12;
    const scale = Math.min(w * (1 - 2 * margin) / (box.x1 - box.x0), h * (1 - 2 * margin) / (box.y1 - box.y0));
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const P = ([x, y]) => [w / 2 + (x - cx) * scale, h / 2 - (y - cy) * scale];
    this.scale = scale;

    let out = "";
    if (ghost) out += `<g opacity="0.35">${this.draw(ghost, P, scale, c, "g")}</g>`;
    out += this.draw(shapes, P, scale, c, "m");
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.innerHTML = out;
  }

  draw(shapes, P, scale, c, prefix) {
    const colourOf = (name, fallback) => (name ? (c[name] ?? name) : fallback);
    let out = "";
    for (const s of shapes) {
      const colour = colourOf(s.colour, null);
      switch (s.kind) {
        case "ground": case "wall": {
          const a = P(s.from), b = P(s.to);
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
          // Hatching on the right of the direction drawn
          const nx = -dy / len, ny = dx / len;
          const step = 9, tick = 7;
          let hatch = "";
          for (let d = step / 2; d < len; d += step) {
            const x = a[0] + dx * d / len, y = a[1] + dy * d / len;
            hatch += `<line x1="${n(x)}" y1="${n(y)}" x2="${n(x + nx * tick - dx / len * tick * 0.6)}" y2="${n(y + ny * tick - dy / len * tick * 0.6)}"/>`;
          }
          out += `<g stroke="${colour ?? c.ink}" stroke-width="1.2"><line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" stroke-width="1.6"/>${hatch}</g>`;
          break;
        }
        case "spring": {
          const a = P(s.from), b = P(s.to);
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
          const turns = Math.max(2, Math.round(s.turns ?? 8));
          const lead = Math.min(10, len * 0.12), width = 12;
          const pts = [a, [a[0] + ux * lead, a[1] + uy * lead]];
          const inner = len - 2 * lead, seg = inner / (turns * 2);
          for (let i = 0; i < turns * 2; i++) {
            const d = lead + seg * (i + 0.5);
            const side = i % 2 ? -1 : 1;
            pts.push([a[0] + ux * d + nx * side * width / 2, a[1] + uy * d + ny * side * width / 2]);
          }
          pts.push([b[0] - ux * lead, b[1] - uy * lead], b);
          out += `<polyline points="${pts.map((p) => `${n(p[0])},${n(p[1])}`).join(" ")}" fill="none" stroke="${colour ?? c.ink}" stroke-width="1.5" stroke-linejoin="round"/>`;
          break;
        }
        case "damper": {
          const a = P(s.from), b = P(s.to);
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
          const size = 12, body = Math.min(26, len * 0.4);
          const m0 = len / 2 - body / 2, m1 = len / 2 + body / 2;
          const at = (d, side = 0) => [a[0] + ux * d + nx * side, a[1] + uy * d + ny * side];
          const line = (p, q, wdt = 1.5) => `<line x1="${n(p[0])}" y1="${n(p[1])}" x2="${n(q[0])}" y2="${n(q[1])}" stroke-width="${wdt}"/>`;
          out += `<g stroke="${colour ?? c.ink}" fill="none">`
            + line(a, at(m0)) + line(at(m0, -size / 2), at(m1, -size / 2)) + line(at(m0, size / 2), at(m1, size / 2))
            + line(at(m0, -size / 2), at(m0, size / 2))
            + line(at(m0 + body * 0.55, -size / 2 + 2), at(m0 + body * 0.55, size / 2 - 2), 2.5)
            + line(at(m0 + body * 0.55), b) + "</g>";
          break;
        }
        case "rod": case "line": case "string": {
          const a = P(s.from), b = P(s.to);
          const width = s.kind === "rod" ? 4 : s.kind === "line" ? 1.5 : 1.2;
          out += `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" stroke="${colour ?? (s.kind === "string" ? c.dim : c.ink)}" stroke-width="${width}" stroke-linecap="round"/>`;
          break;
        }
        case "block": {
          const p = P(s.at);
          const side = s.size != null ? s.size * scale : 24;
          const col = colour ?? c.accent;
          // angle is anticlockwise in radians, as in the maths; the screen turns the other way
          const turn = Number.isFinite(s.angle) && s.angle ? ` transform="rotate(${n(-s.angle * 180 / Math.PI)} ${n(p[0])} ${n(p[1])})"` : "";
          out += `<rect x="${n(p[0] - side / 2)}" y="${n(p[1] - side / 2)}" width="${n(side)}" height="${n(side)}" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-width="1.6"${turn}/>`;
          if (s.label) out += this.text(s.label, p, col, 13, 600, c);
          break;
        }
        case "circle": {
          const p = P(s.at);
          const r = s.r != null ? s.r * scale : 8;
          const col = colour ?? c.accent;
          out += `<circle cx="${n(p[0])}" cy="${n(p[1])}" r="${n(r)}" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-width="1.6"/>`;
          if (s.label) out += this.text(s.label, p, col, 12, 600, c);
          break;
        }
        case "point": {
          const p = P(s.at);
          out += `<circle cx="${n(p[0])}" cy="${n(p[1])}" r="3.5" fill="${colour ?? c.ink}"/>`;
          if (s.label) out += this.text(s.label, [p[0] + 9, p[1] - 9], colour ?? c.ink, 11, 500, c);
          break;
        }
        case "pivot": {
          const p = P(s.at);
          const col = colour ?? c.ink;
          out += `<g stroke="${col}" fill="none" stroke-width="1.4">`
            + `<polygon points="${n(p[0])},${n(p[1])} ${n(p[0] - 9)},${n(p[1] + 13)} ${n(p[0] + 9)},${n(p[1] + 13)}"/>`
            + `<line x1="${n(p[0] - 14)}" y1="${n(p[1] + 13)}" x2="${n(p[0] + 14)}" y2="${n(p[1] + 13)}"/>`
            + `<circle cx="${n(p[0])}" cy="${n(p[1])}" r="3" fill="${c.paper}"/></g>`;
          break;
        }
        case "arrow": {
          const a = P(s.from);
          const b = s.by ? P([s.from[0] + s.by[0], s.from[1] + s.by[1]]) : P(s.to);
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
          if (len < 2) break;
          const ux = dx / len, uy = dy / len, head = Math.min(9, len * 0.5);
          const col = colour ?? c.good;
          const tip = b, l = [b[0] - ux * head - uy * head * 0.45, b[1] - uy * head + ux * head * 0.45];
          const r = [b[0] - ux * head + uy * head * 0.45, b[1] - uy * head - ux * head * 0.45];
          out += `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0] - ux * head * 0.6)}" y2="${n(b[1] - uy * head * 0.6)}" stroke="${col}" stroke-width="2"/>`
            + `<polygon points="${n(tip[0])},${n(tip[1])} ${n(l[0])},${n(l[1])} ${n(r[0])},${n(r[1])}" fill="${col}"/>`;
          if (s.label) out += this.text(s.label, [b[0] + ux * 10, b[1] + uy * 10], col, 11, 500, c);
          break;
        }
        case "trace": {
          const key = `${prefix}${s.index}`;
          const trail = this.traces.get(key) ?? [];
          const last = trail[trail.length - 1];
          if (!last || Math.hypot(last[0] - s.of[0], last[1] - s.of[1]) > 1e-9) trail.push([s.of[0], s.of[1]]);
          if (trail.length > 4000) trail.splice(0, trail.length - 4000);
          this.traces.set(key, trail);
          if (trail.length > 1) {
            out += `<polyline points="${trail.map((q) => { const p = P(q); return `${n(p[0])},${n(p[1])}`; }).join(" ")}" fill="none" stroke="${colour ?? c.violet}" stroke-width="1.2" opacity="0.8"/>`;
          }
          break;
        }
        case "label": {
          out += this.text(s.label ?? "", P(s.at), colour ?? c.dim, 11, 500, c);
          break;
        }
        default: break;
      }
    }
    return out;
  }

  text(label, [x, y], colour, size, weight, c) {
    return `<text x="${n(x)}" y="${n(y)}" text-anchor="middle" dominant-baseline="middle" font-family="${esc(c.font)}" font-size="${size}" font-weight="${weight}" fill="${colour}">${esc(label)}</text>`;
  }
}
