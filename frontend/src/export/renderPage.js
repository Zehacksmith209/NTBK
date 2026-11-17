// ─────────────────────────────────────────────
//  PAGE RASTERISER
//
//  Turns one A4 page into a PNG for the PDF.
//
//  Everything is drawn through an SVG snapshot
//  whose viewBox IS the page rectangle. That is
//  what keeps the promise that nothing outside
//  the paper can be printed: off-page content
//  is not trimmed afterwards, it is never drawn.
// ─────────────────────────────────────────────
import html2canvas from "html2canvas";
import { ensureMaths, typesetToSvg, sourceOf } from "./mathjax.js";
import { printMarginsOf, PX_PER_MM } from "../model/document.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Which object types are live HTML and so have to be rasterised.
// Everything else is already SVG or a bitmap and goes in as vector.
const HTML_TYPES = new Set(["latex", "text", "code", "vars", "sim"]);

/** 2 is ~192dpi against A4 — sharp on paper without enormous files. */
export const DEFAULT_SCALE = 2;

/**
 * Inline every stylesheet the app uses.
 *
 * An SVG drawn into a canvas is loaded in isolation: it cannot reach back out
 * for <link> stylesheets, so anything not carried inside it renders unstyled.
 */
function collectStyles() {
  let text = "";
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) text += `${rule.cssText}\n`;
    } catch {
      // A sheet we are not allowed to read — skip it rather than fail
    }
  }
  return text;
}

let cachedStyles = null;

/**
 * @param clipToMargins  blank the strips a printer cannot reach, so the PDF
 *                       shows exactly what will come out of the machine
 */
export async function renderPageToPng(app, page, scale = DEFAULT_SCALE,
                                      { clipToMargins = false } = {}) {
  cachedStyles = cachedStyles ?? collectStyles();
  // Typesetting is synchronous once loaded, so the bundle has to be in hand
  // before a single box is captured. Failing to load is not fatal: the swap
  // simply does not happen and KaTeX is captured as before.
  await ensureMaths().catch(() => {});

  // Dark mode is how the notebook is VIEWED, not what the notebook IS. A page
  // exported while dark would print white ink on a black sheet and empty a
  // cartridge doing it. html2canvas captures the LIVE element and
  // collectStyles() copies the live stylesheet, so both would carry the dark
  // theme in — the only reliable fix is to put the document back to light for
  // the length of the render.
  const shownTheme = document.documentElement.dataset.theme;
  if (shownTheme === "dark") {
    document.documentElement.dataset.theme = "light";
    // Two frames, so styles are recalculated and painted before we capture
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(page.w * scale));
  svg.setAttribute("height", String(page.h * scale));
  svg.setAttribute("viewBox", `${page.x} ${page.y} ${page.w} ${page.h}`);

  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = cachedStyles;
  svg.appendChild(style);

  const paper = document.createElementNS(SVG_NS, "rect");
  paper.setAttribute("x", String(page.x));
  paper.setAttribute("y", String(page.y));
  paper.setAttribute("width", String(page.w));
  paper.setAttribute("height", String(page.h));
  paper.setAttribute("fill", "#ffffff");
  svg.appendChild(paper);

  // Bottom to top. That is the REVERSE of the layer list, because Layer 1
  // sits on top of everything.
  const layers = app.store.data.canvas.layers ?? [];
  for (const layer of [...layers].reverse()) {
    if (layer.visible === false) continue;
    svg.appendChild(await layerGroup(app, layer, page));
  }

  // Last line of defence. A single foreignObject anywhere in here makes the
  // canvas permanently unreadable, and JSXGraph quietly puts one inside every
  // board it draws — so strip them rather than lose the whole page to it.
  for (const node of svg.querySelectorAll("foreignObject")) node.remove();

  const blob = new Blob([new XMLSerializer().serializeToString(svg)],
    { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(page.w * scale);
    canvas.height = Math.round(page.h * scale);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    // Painting the margin strips out rather than shrinking the viewBox keeps
    // the page a true A4 rectangle, so the PDF still lines up with the paper
    if (clipToMargins) {
      const m = printMarginsOf(app.store.data);
      const px = (mm) => mm * PX_PER_MM * scale;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, px(m.top));
      context.fillRect(0, canvas.height - px(m.bottom), canvas.width, px(m.bottom));
      context.fillRect(0, 0, px(m.left), canvas.height);
      context.fillRect(canvas.width - px(m.right), 0, px(m.right), canvas.height);
    }
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
    if (shownTheme === "dark") document.documentElement.dataset.theme = "dark";
  }
}

async function layerGroup(app, layer, page) {
  const group = document.createElementNS(SVG_NS, "g");

  // The same three decks the canvas uses inside one layer: things you write
  // on, then the ink, then things you work in.
  for (const object of app.store.objects) {
    if (object.layerId !== layer.id || object.visible === false) continue;
    if (object.band === "over" || !overlaps(app, object, page)) continue;
    group.appendChild(await objectNode(app, object));
  }

  for (const stroke of app.store.strokes) {
    if (stroke.layerId !== layer.id || stroke.visible === false) continue;
    if (!overlaps(app, stroke, page)) continue;
    const node = app.host.querySelector(`.ntbk-ink path[data-id="${stroke.id}"]`);
    if (node) group.appendChild(node.cloneNode(true));
  }

  for (const object of app.store.objects) {
    if (object.layerId !== layer.id || object.visible === false) continue;
    if (object.band !== "over" || !overlaps(app, object, page)) continue;
    group.appendChild(await objectNode(app, object));
  }

  return group;
}

/**
 * Put one object into the page's SVG.
 *
 * NOT as a foreignObject. Chromium refuses to let a canvas that has drawn an
 * SVG containing foreignObject be read back — the canvas is permanently
 * tainted and toDataURL throws — so HTML boxes have to be rasterised by
 * walking the DOM instead, and everything else goes in as vector.
 */
/**
 * The rotation and mirroring the canvas applies with a CSS transform.
 *
 * The canvas turns objects about their centre; SVG rotates about the origin,
 * so the same result needs the centre moved to the origin and back. Without
 * this every rotated or flipped object printed in its original orientation.
 */
function transformFor(object) {
  const parts = [];
  const cx = object.x + (object.w ?? 0) / 2;
  const cy = object.y + (object.h ?? 0) / 2;
  if (object.rotation) parts.push(`rotate(${object.rotation} ${cx} ${cy})`);
  if (object.flipX || object.flipY) {
    parts.push(`translate(${cx} ${cy})`);
    parts.push(`scale(${object.flipX ? -1 : 1} ${object.flipY ? -1 : 1})`);
    parts.push(`translate(${-cx} ${-cy})`);
  }
  return parts.join(" ");
}

async function objectNode(app, object) {
  const { node, transformed } = await objectBody(app, object);
  if (transformed) return node;
  const transform = transformFor(object);
  if (!transform) return node;
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("transform", transform);
  group.appendChild(node);
  return group;
}

async function objectBody(app, object) {
  const source = app.scene.objects.elementFor(object.id);
  if (!source) {
    return { node: document.createElementNS(SVG_NS, "g"), transformed: true };
  }

  const x = object.x;
  const y = object.y;
  const w = object.w ?? source.offsetWidth;
  const h = object.h ?? source.offsetHeight;

  // A video cannot be printed, and its player is another site's page that
  // cannot be photographed either. What goes on paper is a labelled frame
  // carrying the address, so the reader knows what was there and where to
  // find it.
  if (object.type === "video") {
    return { node: videoPlaceholder(object, x, y, w, h), transformed: false };
  }

  // A plot is already SVG: lift it straight in and it stays sharp at any
  // print resolution rather than being flattened to pixels.
  const ownSvg = !HTML_TYPES.has(object.type) && source.querySelector("svg");
  if (ownSvg) {
    const clone = ownSvg.cloneNode(true);
    for (const node of clone.querySelectorAll("foreignObject")) node.remove();

    // A viewBox is what makes the content SCALE into the new size. Without
    // one, setting width/height only moves the viewport, and the board's grid
    // and axis labels spill out across the rest of the page.
    const box = ownSvg.viewBox?.baseVal;
    const nativeW = box?.width || ownSvg.width?.baseVal?.value || w;
    const nativeH = box?.height || ownSvg.height?.baseVal?.value || h;
    clone.setAttribute("viewBox", `0 0 ${nativeW} ${nativeH}`);
    clone.setAttribute("x", String(x));
    clone.setAttribute("y", String(y));
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    clone.setAttribute("preserveAspectRatio", "none");
    // A nested svg clips to its own viewport, which keeps the plot in its box
    clone.setAttribute("overflow", "hidden");
    return { node: clone, transformed: false };
  }

  // An image or a PDF page is a bitmap already
  const img = source.querySelector("img");
  if (img?.src) {
    const node = document.createElementNS(SVG_NS, "image");
    node.setAttribute("x", String(x));
    node.setAttribute("y", String(y));
    node.setAttribute("width", String(w));
    node.setAttribute("height", String(h));
    node.setAttribute("href", inlineBitmap(img));
    return { node, transformed: false };
  }

  // Everything else is HTML — formulas, text, code cells
  const png = await rasteriseHtml(source, w, h);
  const node = document.createElementNS(SVG_NS, "image");
  node.setAttribute("x", String(x));
  node.setAttribute("y", String(y));
  node.setAttribute("width", String(w));
  node.setAttribute("height", String(h));
  if (png) node.setAttribute("href", png);
  return { node, transformed: false };
}

function videoPlaceholder(object, x, y, w, h) {
  const make = (tag, attrs, text) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const group = make("g", {});
  group.appendChild(make("rect", { x, y, width: w, height: h, rx: 4,
    fill: "#f3f4f6", stroke: "#9aa1ac", "stroke-width": 1 }));
  const cx = x + w / 2;
  const cy = y + h / 2 - 8;
  group.appendChild(make("polygon", {
    points: `${cx - 11},${cy - 14} ${cx - 11},${cy + 14} ${cx + 14},${cy}`, fill: "#5b6470" }));
  const url = String(object.payload?.url ?? "");
  // Cut to what fits the frame, roughly six pixels a character at this size
  const room = Math.max(8, Math.floor((w - 16) / 6));
  const shown = url.length > room ? `${url.slice(0, room - 1)}…` : url;
  group.appendChild(make("text", { x: cx, y: cy + 34, "text-anchor": "middle",
    "font-family": "Helvetica, Arial, sans-serif", "font-size": 11, fill: "#1c1f24" },
    `Video: ${shown}`));
  return group;
}

/**
 * Turn a bitmap into a data URL so it travels INSIDE the page's SVG.
 *
 * A referenced blob: or object URL has to be fetched while the SVG is being
 * decoded, and that fetch does not finish before the image's own `load`
 * fires — so the snapshot is taken with the bitmap still missing, and
 * pictures and imported PDF pages silently vanish from the export. Carrying
 * the pixels inline removes the fetch, and therefore the race.
 */
function inlineBitmap(img) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    if (!canvas.width || !canvas.height) return img.src;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return img.src;   // tainted or undecoded: the reference is still better
  }
}

async function rasteriseHtml(element, w, h) {
  // html2canvas lays text out with slightly different metrics than the
  // browser does, so rows sized tightly on screen crop their text when
  // rasterised. This class loosens exactly those constraints for the
  // duration of the capture and nothing else.
  // Selection outlines and the editing backdrop are chrome, not content, and
  // this captures the LIVE element — so they have to come off for the shot.
  const stateClasses = ["is-selected", "is-editing", "is-peeked"]
    .filter((name) => element.classList.contains(name));
  element.classList.remove(...stateClasses);
  // Capture it square. html2canvas renders the element as it is laid out,
  // rotation included, then crops to the box — so a turned formula came out
  // as a sliver. The SVG applies the rotation afterwards, the same way it
  // does for plots and pictures, so every object turns the same way.
  const ownTransform = element.style.transform;
  element.style.transform = "none";
  element.classList.add("is-exporting");
  // Placeholders are instructions to the user, not content. Styling them away
  // does not work — html2canvas paints them as ordinary text — so the
  // attribute itself is removed for the duration of the capture.
  const hushed = [...element.querySelectorAll("input[placeholder], textarea[placeholder]")]
    .filter((node) => !node.value)
    .map((node) => {
      const text = node.getAttribute("placeholder");
      node.removeAttribute("placeholder");
      return { node, text };
    });
  const maths = swapInMathJax(element);
  try {
    const canvas = await html2canvas(element, {
      backgroundColor: null,
      scale: DEFAULT_SCALE,
      logging: false,
      width: w,
      height: h,
      // The element is inside the canvas's pan/zoom transform; html2canvas
      // must measure it on its own terms, not through that
      x: 0,
      y: 0,
      scrollX: 0,
      scrollY: 0,
      ignoreElements: (node) =>
        node.classList?.contains("ntbk-graph-edit")
        || node.classList?.contains("ntbk-code-run")
        || node.classList?.contains("ntbk-code-stop"),
    });
    return canvas.toDataURL("image/png");
  } catch {
    return null;   // one unrenderable box must not lose the whole page
  } finally {
    element.classList.remove("is-exporting");
    element.style.transform = ownTransform;
    if (stateClasses.length) element.classList.add(...stateClasses);
    for (const { node, text } of hushed) node.setAttribute("placeholder", text);
    for (const { svg, katex } of maths) svg.replaceWith(katex);
  }
}

/**
 * Put MathJax SVG where KaTeX's HTML is, for the length of one capture.
 *
 * KaTeX positions an equation as an inline-block sitting on an empty strut,
 * so where it lands is the browser's baseline arithmetic — and WKWebView and
 * Chromium do not agree on it. That disagreement is the 3px drift: it showed
 * in the app, never in the dev browser, and no amount of measuring in one
 * predicted the other. MathJax's SVG carries its own layout and an explicit
 * vertical-align, so there is no strut left to disagree about.
 *
 * Swapped in the LIVE element, exactly as the class and placeholder handling
 * above already do, and put back in the same `finally`. Nothing is re-parsed:
 * the original KaTeX nodes are kept and reinstated, so the editor never sees
 * a document it did not write.
 */
function swapInMathJax(element) {
  const swapped = [];
  for (const katex of element.querySelectorAll(".katex")) {
    // A display equation renders .katex inside .katex-display; only handle
    // the outer one, or the inner would be swapped and then orphaned.
    if (katex.parentElement?.closest(".katex")) continue;
    const source = sourceOf(katex);
    if (!source) continue;
    const display = !!katex.closest(".katex-display");
    const svg = typesetToSvg(source, display);
    if (!svg) continue;      // leave KaTeX in place rather than lose the maths

    // MathJax sizes in ex, which is relative to the font of wherever it
    // lands. The box it is replacing already has the right size on screen,
    // so pin the rendered height to it and let the width follow the ratio.
    const box = katex.getBoundingClientRect();
    const ratio = box.width && box.height ? box.width / box.height : null;
    if (ratio) {
      svg.style.height = `${box.height}px`;
      svg.style.width = `${box.height * ratio}px`;
    }
    svg.style.verticalAlign = display ? "middle" : "-0.25em";
    if (display) svg.style.display = "block";
    if (display) svg.style.margin = "0 auto";

    katex.replaceWith(svg);
    swapped.push({ svg, katex });
  }
  return swapped;
}

function overlaps(app, element, page) {
  const bounds = element.kind
    ? app.selectionController.boundsOf([element.id])
    : { minX: element.x, minY: element.y,
        maxX: element.x + (element.w ?? 0), maxY: element.y + (element.h ?? 0) };
  if (!bounds) return false;
  return bounds.maxX >= page.x && bounds.minX <= page.x + page.w
      && bounds.maxY >= page.y && bounds.minY <= page.y + page.h;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not rasterise the page"));
    image.src = url;
  });
}
