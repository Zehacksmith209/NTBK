// ─────────────────────────────────────────────
//  PLOT SNAPSHOT
//
//  Turns a finished JSXGraph board into a plain
//  picture, so a plot that is only being looked
//  at costs the page one image instead of a live
//  board and hundreds of SVG nodes.
//
//  The board's SVG is copied, made to stand on
//  its own, and painted onto a canvas. Three
//  things have to be done to the copy or the
//  picture comes out wrong:
//
//  - foreignObject is removed. Chromium marks a
//    canvas as tainted the moment it draws an
//    SVG containing one, and a tainted canvas
//    cannot be read back.
//  - Text gets its computed font written inline.
//    An SVG loaded as an image has no page
//    stylesheet, so inherited fonts are lost and
//    every label falls back to a serif.
//  - It is given explicit size and a viewBox, or
//    the image has no intrinsic dimensions.
// ─────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";

// Pixels per CSS pixel. Three keeps a plot sharp on a Retina screen with the
// canvas zoomed in a bit; the cap stops one huge plot holding a huge bitmap.
const SCALE = 3;
const MAX_PIXELS = 3_000_000;

export function snapshotScale(w, h) {
  return Math.max(1, Math.min(SCALE, Math.sqrt(MAX_PIXELS / Math.max(1, w * h))));
}

/** A standalone copy of a board's SVG, as markup. */
export function standaloneSvg(svg, w, h) {
  const clone = svg.cloneNode(true);
  for (const node of clone.querySelectorAll("foreignObject")) node.remove();

  const live = svg.querySelectorAll("text");
  const copy = clone.querySelectorAll("text");
  for (let i = 0; i < live.length && i < copy.length; i++) {
    const style = getComputedStyle(live[i]);
    copy[i].style.fontFamily = style.fontFamily;
    copy[i].style.fontSize = style.fontSize;
    copy[i].style.fontWeight = style.fontWeight;
    copy[i].style.fontStyle = style.fontStyle;
  }

  const box = svg.viewBox?.baseVal;
  const nativeW = box?.width || svg.width?.baseVal?.value || w;
  const nativeH = box?.height || svg.height?.baseVal?.value || h;
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("viewBox", `0 0 ${nativeW} ${nativeH}`);
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.style.position = "static";
  return new XMLSerializer().serializeToString(clone);
}

/**
 * Photograph a board: its SVG, plus the labels JSXGraph keeps outside it.
 *
 * A 3D view writes its axis names and tick labels as HTML elements laid over
 * the SVG rather than as SVG text, so copying the SVG alone gives a surface
 * with no "X", "Y" or "Z" on it. Those are drawn onto the canvas afterwards,
 * each at the place and in the font the browser gave it.
 *
 * Resolves to an object URL for a PNG, or null. Null is not an error: a plot
 * that cannot be photographed simply stays live, which is slower but never
 * wrong. The caller owns the URL and must revoke it.
 */
export async function snapshotBoard(holder, w, h) {
  const svg = holder?.querySelector("svg");
  if (!svg || w < 1 || h < 1) return null;
  let url = null;
  try {
    const markup = standaloneSvg(svg, w, h);
    url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
    const image = new Image();
    image.decoding = "async";
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("svg did not load"));
      image.src = url;
    });

    const scale = snapshotScale(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawHtmlLabels(context, holder, w, scale);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function drawHtmlLabels(context, holder, w, scale) {
  const frame = holder.getBoundingClientRect();
  if (!frame.width) return;
  // The holder sits inside the zoomed, panned canvas, so screen distances
  // have to be divided back down to the board's own pixels.
  const zoom = frame.width / w;
  for (const label of holder.querySelectorAll("div.JXGtext")) {
    const text = label.textContent.trim();
    if (!text) continue;
    const style = getComputedStyle(label);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const box = label.getBoundingClientRect();
    if (!box.width || !box.height) continue;

    const x = ((box.left + box.width / 2) - frame.left) / zoom;
    const y = ((box.top + box.height / 2) - frame.top) / zoom;
    context.font = `${style.fontStyle} ${style.fontWeight} `
      + `${parseFloat(style.fontSize) * scale}px ${style.fontFamily}`;
    context.fillStyle = style.color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, x * scale, y * scale);
  }
}

// ── One at a time ───────────────────────────
// Opening a notebook mounts every plot at once. Photographing them all in the
// same frame would freeze the page for exactly the moment it should feel
// fastest, so jobs wait in a line and run one per turn of the event loop.
const jobs = [];
let running = false;

export function queueSnapshot(job) {
  jobs.push(job);
  if (!running) pump();
}

async function pump() {
  running = true;
  while (jobs.length) {
    const job = jobs.shift();
    try { await job(); } catch { /* one bad plot must not stop the rest */ }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  running = false;
}
