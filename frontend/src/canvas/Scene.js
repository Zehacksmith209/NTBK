import { printMarginsOf, PX_PER_MM } from "../model/document.js";
import { InkLayer } from "./InkLayer.js";
import { ObjectLayer } from "./ObjectLayer.js";
import { SpatialIndex } from "./spatial.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// ─────────────────────────────────────────────
//  SCENE
//
//  Layer stack, bottom to top:
//    page backgrounds
//    object layer   (content — under the ink)
//    ink layer      (SVG, pointer-events: none)
//    overlay layer  (objects that float above ink)
//    chrome layer   (marquee, guides — NOT in the document)
//
//  Ink over objects is deliberate: an inserted
//  box should behave like part of the page you
//  can write on, not a panel stuck on top of it.
// ─────────────────────────────────────────────
export class Scene {
  constructor(host, store, context) {
    this.host = host;
    this.store = store;

    host.classList.add("ntbk-viewport");
    host.innerHTML = `
      <div class="ntbk-scene">
        <div class="ntbk-pages"></div>
        <div class="ntbk-layers"></div>
        <svg class="ntbk-layer ntbk-chrome" xmlns="${SVG_NS}"></svg>
        <div class="ntbk-proxy" hidden></div>
      </div>`;

    this.sceneEl = host.querySelector(".ntbk-scene");
    this.pagesEl = host.querySelector(".ntbk-pages");
    this.chromeEl = host.querySelector(".ntbk-chrome");
    // A single element Moveable can target, sized to the selection bounds.
    // Far simpler than pointing Moveable at a dozen individual SVG paths.
    this.proxyEl = host.querySelector(".ntbk-proxy");

    this.layersEl = host.querySelector(".ntbk-layers");
    this.context = context;

    // One ink layer and one object layer PER user layer, stacked in list
    // order. The old fixed arrangement could only ever put every stroke
    // above every object; this can interleave them.
    this.inkByLayer = new Map();
    this.objectsByLayer = new Map();
    this.ink = new InkRouter(this);
    this.objects = new ObjectRouter(this);
    this.index = new SpatialIndex();

    // ── View transform ──
    // Driven here rather than by Panzoom. Panzoom tracked its own pan state
    // happily but would not write the transform to the element under this
    // setup, and each workaround broke something else: disablePan blocks
    // programmatic pan(), throwing from handleStartEvent aborts pan() and
    // zoom() too, and passing `origin` stops the write entirely.
    //
    // It is one CSS property and the maths was already ours.
    this.view = { x: 0, y: 0, scale: 1 };
    this._applyView();

    host.addEventListener("wheel", this._onWheel, { passive: false });

    this.buildLayers();
    this.renderPages();
    this.renderAll();
    store.subscribe((change) => this._onChange(change));
  }

  _onWheel = (event) => {
    event.preventDefault();
    // Trackpad pinch arrives as ctrlKey+wheel; a plain wheel scrolls
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.01);
      this.zoomAt(this.view.scale * factor, event.clientX, event.clientY);
    } else {
      this.panBy(-event.deltaX, -event.deltaY);
    }
  };

  _applyView() {
    const { x, y, scale } = this.view;
    // Land the page on WHOLE device pixels.
    //
    // A fractional offset — which any pan leaves behind — puts every pixel
    // halfway between two real ones, so the display resamples the lot. Ink
    // and images both go soft, and the softness changes as you pan, which is
    // what makes it feel like quality is degrading. `view` keeps the exact
    // value, so nothing drifts; only what is drawn is snapped.
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(x * dpr) / dpr;
    const py = Math.round(y * dpr) / dpr;
    this.sceneEl.style.transform = `translate(${px}px, ${py}px) scale(${scale})`;
  }

  _emitTransform() {
    this.host.dispatchEvent(new CustomEvent("scene:transform"));
  }

  panBy(dx, dy) {
    this.view.x += dx;
    this.view.y += dy;
    this._applyView();
    this._emitTransform();
  }

  /** Zoom so the scene point under (clientX, clientY) stays put. */
  zoomAt(nextScale, clientX, clientY) {
    const scale = Math.max(0.1, Math.min(8, nextScale));
    const hostRect = this.host.getBoundingClientRect();
    const point = this.toScene(clientX, clientY);

    this.view.scale = scale;
    this.view.x = clientX - hostRect.left - point.x * scale;
    this.view.y = clientY - hostRect.top - point.y * scale;
    this._applyView();
    this._emitTransform();
  }

  // ── Coordinates ───────────────────────────
  get scale() { return this.view.scale; }

  /** Screen (client) coordinates to scene coordinates. */
  toScene(clientX, clientY) {
    const rect = this.sceneEl.getBoundingClientRect();
    const scale = this.scale;
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  }

  zoomBy(factor) {
    const rect = this.host.getBoundingClientRect();
    this.zoomAt(this.view.scale * factor,
                rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  resetView() {
    this.view = { x: 0, y: 0, scale: 1 };
    this._applyView();
    this._emitTransform();
  }

  // ── Layers ────────────────────────────────
  get layers() {
    return this.store.data.canvas.layers ?? [];
  }

  layerIdFor(element) {
    return element.layerId ?? this.layers[0]?.id;
  }

  /** Rebuild the container stack to match the layer list and its order. */
  buildLayers() {
    for (const ink of this.inkByLayer.values()) ink.el.parentElement?.remove();
    this.inkByLayer.clear();
    this.objectsByLayer.clear();
    this.layersEl.innerHTML = "";

    // Layer 1 sits on TOP, so the list is painted back to front: the last
    // layer goes down first and Layer 1 lands over everything.
    for (const layer of [...this.layers].reverse()) {
      const holder = document.createElement("div");
      holder.className = "ntbk-layer-stack";
      holder.dataset.layer = layer.id;
      holder.hidden = layer.visible === false;

      // Order inside a layer: objects you write on, then ink, then objects
      // you work in
      const under = document.createElement("div");
      under.className = "ntbk-layer ntbk-objects";
      const ink = document.createElementNS(SVG_NS, "svg");
      ink.setAttribute("class", "ntbk-layer ntbk-ink");
      const over = document.createElement("div");
      over.className = "ntbk-layer ntbk-overlay";

      holder.append(under, ink, over);
      this.layersEl.appendChild(holder);

      this.inkByLayer.set(layer.id, new InkLayer(ink));
      this.objectsByLayer.set(layer.id, new ObjectLayer(under, over, this.context));
    }
  }

  refreshLayerVisibility() {
    for (const layer of this.layers) {
      const holder = this.layersEl.querySelector(`[data-layer="${layer.id}"]`);
      if (holder) holder.hidden = layer.visible === false;
    }
  }

  // ── Rendering ─────────────────────────────
  renderPages() {
    const { pages, background } = this.store.data.canvas;
    this.pagesEl.innerHTML = "";
    for (const page of pages) {
      const el = document.createElement("div");
      el.className = "ntbk-page";
      el.style.left = `${page.x}px`;
      el.style.top = `${page.y}px`;
      el.style.width = `${page.w}px`;
      el.style.height = `${page.h}px`;
      if (background.type === "grid") {
        el.style.setProperty("--grid-size", `${background.spacing}px`);
        el.style.setProperty("--grid-color", background.color);
        el.classList.add("is-grid");
      }
      // The printer's dead zone, drawn as a guide. It is a hint, never
      // content: it is not selectable and it is excluded from printing.
      const margins = printMarginsOf(this.store.data);
      const guide = document.createElement("div");
      guide.className = "ntbk-page-margins";
      guide.style.inset = [margins.top, margins.right, margins.bottom, margins.left]
        .map((mm) => `${(mm * PX_PER_MM).toFixed(1)}px`).join(" ");
      el.appendChild(guide);

      const number = document.createElement("div");
      number.className = "ntbk-page-number";
      number.textContent = String(page.index + 1);
      el.appendChild(number);

      this.pagesEl.appendChild(el);
    }
  }

  renderAll() {
    for (const ink of this.inkByLayer.values()) ink.clear();
    for (const objects of this.objectsByLayer.values()) objects.clear();

    for (const stroke of this.store.strokes) this.ink.render(stroke);
    for (const object of this.store.objects) this.objects.render(object);
    this.index.rebuild(this.store.strokes);
  }

  _onChange(change) {
    if (change.type === "layers") {
      this.buildLayers();
      this.renderAll();
      this.host.dispatchEvent(new CustomEvent("scene:changed", { detail: change }));
      return;
    }

    if (change.type === "pages") {
      this.renderPages();
      this.host.dispatchEvent(new CustomEvent("scene:changed", { detail: change }));
      return;
    }

    if (change.type === "reload") {
      // A new document brings its own layers. Rebuilding the stacks first is
      // what stops every element routing to the previous document's layer id
      // and disappearing without a word.
      this.buildLayers();
      this.renderPages();
      this.renderAll();
      this.host.dispatchEvent(new CustomEvent("scene:reload"));
      return;
    }

    if (change.type === "remove") {
      for (const id of change.ids) {
        this.ink.remove(id);
        this.objects.remove(id);
        this.index.remove(id);
      }
    } else {
      for (const id of change.ids) {
        const element = this.store.find(id);
        if (!element) continue;
        if (element.kind) {
          this.ink.render(element);
          this.index.insert(element);
        } else {
          this.objects.render(element);
        }
      }
    }
    this.host.dispatchEvent(new CustomEvent("scene:changed", { detail: change }));
  }

  // ── Chrome (never part of the document) ───
  drawMarquee(rect) {
    this.clearChrome();
    const el = document.createElementNS(SVG_NS, "rect");
    el.setAttribute("x", rect.minX);
    el.setAttribute("y", rect.minY);
    el.setAttribute("width", rect.maxX - rect.minX);
    el.setAttribute("height", rect.maxY - rect.minY);
    el.setAttribute("class", "ntbk-marquee");
    this.chromeEl.appendChild(el);
  }

  drawPath(d, className) {
    const el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("d", d);
    el.setAttribute("class", className);
    this.chromeEl.appendChild(el);
    return el;
  }

  clearChrome() {
    this.chromeEl.innerHTML = "";
  }
}


// ─────────────────────────────────────────────
//  ROUTERS
//
//  The rest of the app still says scene.ink.render(stroke) without caring
//  which layer it lands in. These send each element to its layer's renderer
//  and hide the fact that there are now many.
// ─────────────────────────────────────────────
/**
 * Falling back to the bottom layer for an element whose layer has gone missing.
 * Showing it in the wrong place is recoverable; silently not drawing it is not.
 */
function firstOf(map) {
  for (const value of map.values()) return value;
  return null;
}

class InkRouter {
  constructor(scene) { this.scene = scene; }

  _for(stroke) {
    return this.scene.inkByLayer.get(this.scene.layerIdFor(stroke))
      ?? firstOf(this.scene.inkByLayer);
  }

  render(stroke) {
    if (stroke.visible === false) { this.remove(stroke.id); return null; }
    return this._for(stroke)?.render(stroke) ?? null;
  }

  remove(id) {
    for (const ink of this.scene.inkByLayer.values()) ink.remove(id);
  }

  clear() {
    for (const ink of this.scene.inkByLayer.values()) ink.clear();
  }

  setHighlighted(ids) {
    for (const ink of this.scene.inkByLayer.values()) ink.setHighlighted(ids);
  }
}

class ObjectRouter {
  constructor(scene) { this.scene = scene; }

  _for(object) {
    return this.scene.objectsByLayer.get(this.scene.layerIdFor(object))
      ?? firstOf(this.scene.objectsByLayer);
  }

  get nodes() {
    const all = new Map();
    for (const layer of this.scene.objectsByLayer.values()) {
      for (const [id, node] of layer.nodes) all.set(id, node);
    }
    return all;
  }

  render(object) {
    if (object.visible === false) { this.remove(object.id); return null; }
    return this._for(object)?.render(object) ?? null;
  }

  remove(id) {
    for (const layer of this.scene.objectsByLayer.values()) layer.remove(id);
  }

  clear() {
    for (const layer of this.scene.objectsByLayer.values()) layer.clear();
  }

  elementFor(id) {
    for (const layer of this.scene.objectsByLayer.values()) {
      const el = layer.elementFor(id);
      if (el) return el;
    }
    return null;
  }

  setHighlighted(ids) {
    for (const layer of this.scene.objectsByLayer.values()) layer.setHighlighted(ids);
  }
}
