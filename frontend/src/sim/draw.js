// ─────────────────────────────────────────────
//  DRAWING HELPERS FOR SIMULATIONS
//
//  Canvas 2D, in the app's own colours, read
//  from the theme each frame so a simulation
//  follows light and dark mode without being
//  colour-inverted like a picture.
// ─────────────────────────────────────────────

export function palette() {
  const css = getComputedStyle(document.documentElement);
  const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    ink: get("--text", "#1c1f24"),
    dim: get("--text-dim", "#666c76"),
    line: get("--line", "#c8ccd3"),
    soft: get("--line-soft", "#dcdfe4"),
    accent: get("--accent", "#1a6ef5"),
    paper: get("--field", "#ffffff"),
    warm: "#d9822b",
    good: "#2f9e6e",
    bad: "#d0483a",
    violet: "#8c5ba8",
    font: get("--font", "system-ui, sans-serif"),
  };
}

/** Size the canvas to its box at the screen's pixel density; returns the context in CSS pixels. */
export function prepare(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** A coil spring from (x1, y1) to (x2, y2), with a fixed number of turns. */
export function spring(ctx, x1, y1, x2, y2, { turns = 10, width = 14, lead = 10 } = {}) {
  const dx = x2 - x1, dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length;
  const nx = -uy, ny = ux;
  const body = Math.max(1, length - 2 * lead);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + ux * lead, y1 + uy * lead);
  const points = turns * 2;
  for (let i = 1; i < points; i++) {
    const along = lead + (body * i) / points;
    const side = (i % 2 ? 1 : -1) * width / 2;
    ctx.lineTo(x1 + ux * along + nx * side, y1 + uy * along + ny * side);
  }
  ctx.lineTo(x2 - ux * lead, y2 - uy * lead);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** A dashpot (damper) from (x1, y) to (x2, y), drawn horizontally. */
export function damper(ctx, x1, x2, y, { size = 12 } = {}) {
  const mid = (x1 + x2) / 2;
  const cup = Math.max(16, (x2 - x1) * 0.35);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(mid - cup / 2, y);
  // the cylinder, open towards the piston
  ctx.moveTo(mid + cup / 2, y - size / 2);
  ctx.lineTo(mid - cup / 2, y - size / 2);
  ctx.lineTo(mid - cup / 2, y + size / 2);
  ctx.lineTo(mid + cup / 2, y + size / 2);
  // the piston
  ctx.moveTo(mid + 2, y - size / 2 + 3);
  ctx.lineTo(mid + 2, y + size / 2 - 3);
  ctx.moveTo(mid + 2, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

/** A fixed wall or floor: a line with hatching behind it. */
export function ground(ctx, x1, y1, x2, y2, { side = 1, step = 8, depth = 7 } = {}) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const length = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / length, uy = (y2 - y1) / length;
  const nx = -uy * side, ny = ux * side;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = 0; d <= length; d += step) {
    const px = x1 + ux * d, py = y1 + uy * d;
    ctx.moveTo(px, py);
    ctx.lineTo(px + nx * depth - ux * depth * 0.6, py + ny * depth - uy * depth * 0.6);
  }
  ctx.stroke();
  ctx.restore();
}

/** An arrow from (x1, y1) to (x2, y2). Drawn only when it is long enough to read. */
export function arrow(ctx, x1, y1, x2, y2, { head = 7 } = {}) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < 3) return;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - 0.4), y2 - head * Math.sin(angle - 0.4));
  ctx.lineTo(x2 - head * Math.cos(angle + 0.4), y2 - head * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

export function label(ctx, text, x, y, { align = "center", base = "middle", size = 11, colour, weight = 500, font } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font ?? palette().font}`;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  if (colour) ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Pixels per metre so that `span` metres fit `pixels`, rounded to a tidy
 * number so the scale bar reads cleanly.
 */
export function fitScale(span, pixels) {
  return pixels / Math.max(span, 1e-9);
}

/** A scale bar labelled in metres, bottom-left. */
export function scaleBar(ctx, perMetre, x, y, colour) {
  const target = 80 / perMetre;                     // about 80 px long
  const power = 10 ** Math.floor(Math.log10(target));
  const nice = [1, 2, 5, 10].map((m) => m * power).find((m) => m >= target * 0.6) ?? power;
  const px = nice * perMetre;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4);
  ctx.stroke();
  const text = nice >= 1 ? `${+nice.toPrecision(3)} m`
    : nice >= 0.01 ? `${+(nice * 100).toPrecision(3)} cm` : `${+(nice * 1000).toPrecision(3)} mm`;
  label(ctx, text, x + px / 2, y - 10, { size: 10, colour });
  ctx.restore();
}
