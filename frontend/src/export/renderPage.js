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
import { printMarginsOf, PX_PER_MM } from "../model/document.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Which object types are live HTML and so have to be rasterised.
// Everything else is already SVG or a bitmap and goes in as vector.
const HTML_TYPES = new Set(["latex", "text", "code"]);

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
async function objectNode(app, object) {
  const source = app.scene.objects.elementFor(object.id);
  if (!source) return document.createElementNS(SVG_NS, "g");

  const x = object.x;
  const y = object.y;
  const w = object.w ?? source.offsetWidth;
  const h = object.h ?? source.offsetHeight;

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
    return clone;
  }

  // An image or a PDF page is a bitmap already
  const img = source.querySelector("img");
  if (img?.src) {
    const node = document.createElementNS(SVG_NS, "image");
    node.setAttribute("x", String(x));
    node.setAttribute("y", String(y));
    node.setAttribute("width", String(w));
    node.setAttribute("height", String(h));
    node.setAttribute("href", img.src);
    return node;
  }

  // Everything else is HTML — formulas, text, code cells
  const png = await rasteriseHtml(source, w, h);
  const node = document.createElementNS(SVG_NS, "image");
  node.setAttribute("x", String(x));
  node.setAttribute("y", String(y));
  node.setAttribute("width", String(w));
  node.setAttribute("height", String(h));
  if (png) node.setAttribute("href", png);
  return node;
}

async function rasteriseHtml(element, w, h) {
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
  }
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
