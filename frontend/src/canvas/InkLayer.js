import { getStroke } from "perfect-freehand";
import polygonClipping from "polygon-clipping";

const SVG_NS = "http://www.w3.org/2000/svg";

// ─────────────────────────────────────────────
//  INK LAYER
//
//  One <path> per stroke. The stored points are
//  the input spine; the filled outline is
//  regenerated on every render, which is what
//  lets a stroke be restyled or rescaled after
//  the fact without ever losing fidelity.
// ─────────────────────────────────────────────

/** perfect-freehand gives an outline; turn it into a path `d`. */
export function outlineToPath(outline) {
  if (!outline.length) return "";
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...outline[0], "Q"],
  );
  d.push("Z");
  return d.join(" ");
}

function ringsToPath(rings) {
  let d = "";
  for (const polygon of rings) {
    for (const ring of polygon) {
      d += `M ${ring[0][0]} ${ring[0][1]} `;
      for (let i = 1; i < ring.length; i++) d += `L ${ring[i][0]} ${ring[i][1]} `;
      d += "Z ";
    }
  }
  return d.trim();
}

/**
 * A geometric shape as a plain polyline.
 *
 * Shapes are NOT run through perfect-freehand. That builds a filled outline
 * around a path, which for a closed rectangle wraps the whole thing and
 * renders a rounded blob rather than four straight edges.
 */
export function shapeToPathData(stroke) {
  const { points, stride } = stroke;
  if (points.length < stride) return "";
  let d = `M ${points[0]} ${points[1]}`;
  for (let i = stride; i < points.length; i += stride) {
    d += ` L ${points[i]} ${points[i + 1]}`;
  }
  return d;
}

export function strokeToPathData(stroke) {
  const { points, stride, style } = stroke;

  // perfect-freehand takes [x, y, pressure] triples
  const input = [];
  for (let i = 0; i < points.length; i += stride) {
    input.push([points[i], points[i + 1], points[i + 2] ?? 0.5]);
  }

  const outline = getStroke(input, {
    size: style.size,
    thinning: style.thinning ?? 0.5,
    smoothing: style.smoothing ?? 0.5,
    streamline: style.streamline ?? 0.5,
    simulatePressure: style.simulatePressure ?? true,
    start: { taper: style.taperStart ?? 0, cap: true },
    end: { taper: style.taperEnd ?? 0, cap: true },
    last: stroke.done !== false,
  });

  // Erasure is stored as subtractive masks rather than applied destructively,
  // so the original points survive and the stroke stays restylable.
  if (stroke.erase?.length) {
    try {
      const result = polygonClipping.difference([outline], ...stroke.erase.map((p) => [p]));
      return ringsToPath(result);
    } catch {
      // A degenerate mask shouldn't lose the stroke
      return outlineToPath(outline);
    }
  }

  return outlineToPath(outline);
}

export class InkLayer {
  constructor(svgElement) {
    this.el = svgElement;
    this.paths = new Map(); // id -> <path>
  }

  _ensure(stroke) {
    let path = this.paths.get(stroke.id);
    if (!path) {
      path = document.createElementNS(SVG_NS, "path");
      path.dataset.id = stroke.id;
      this.paths.set(stroke.id, path);
      this.el.appendChild(path);
    }
    return path;
  }

  render(stroke) {
    const path = this._ensure(stroke);

    if (stroke.kind === "shape") {
      // Stroked, not filled: a shape is a line of constant width
      path.setAttribute("d", shapeToPathData(stroke));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke.style.color);
      path.setAttribute("stroke-width", String(stroke.style.size ?? 2));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("opacity", String(stroke.style.opacity ?? 1));
      path.style.mixBlendMode = "normal";
      this._applyOrder(stroke, path);
      return path;
    }

    path.removeAttribute("stroke");
    path.removeAttribute("stroke-width");
    path.setAttribute("d", strokeToPathData(stroke));
    path.setAttribute("fill", stroke.style.color);
    path.setAttribute("fill-rule", "nonzero");
    path.setAttribute("opacity", String(stroke.style.opacity ?? 1));
    // Highlighter multiplies so overlapping ink stays readable underneath
    path.style.mixBlendMode = stroke.style.blend === "multiply" ? "multiply" : "normal";
    this._applyOrder(stroke, path);
    return path;
  }

  // Highlighter renders beneath pen ink. Both live in the same SVG, so the
  // ordering is done by moving nodes rather than by z-index.
  _applyOrder(stroke, path) {
    const wantsBack = stroke.kind === "highlighter";
    const isFirstChild = this.el.firstChild === path;
    if (wantsBack && !isFirstChild) this.el.insertBefore(path, this.el.firstChild);
  }

  remove(id) {
    this.paths.get(id)?.remove();
    this.paths.delete(id);
  }

  clear() {
    for (const path of this.paths.values()) path.remove();
    this.paths.clear();
  }

  setHighlighted(ids) {
    const set = new Set(ids);
    for (const [id, path] of this.paths) {
      path.classList.toggle("is-selected", set.has(id));
    }
  }
}
