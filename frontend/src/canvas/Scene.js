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
        <div class="ntbk-layer ntbk-objects"></div>
        <svg class="ntbk-layer ntbk-ink" xmlns="${SVG_NS}"></svg>
        <div class="ntbk-layer ntbk-overlay"></div>
        <svg class="ntbk-layer ntbk-chrome" xmlns="${SVG_NS}"></svg>
        <div class="ntbk-proxy" hidden></div>
      </div>`;

    this.sceneEl = host.querySelector(".ntbk-scene");
    this.pagesEl = host.querySelector(".ntbk-pages");
    this.chromeEl = host.querySelector(".ntbk-chrome");
    // A single element Moveable can target, sized to the selection bounds.
    // Far simpler than pointing Moveable at a dozen individual SVG paths.
    this.proxyEl = host.querySelector(".ntbk-proxy");

    this.ink = new InkLayer(host.querySelector(".ntbk-ink"));
    this.objects = new ObjectLayer(
      host.querySelector(".ntbk-objects"),
      host.querySelector(".ntbk-overlay"),
      context,
    );
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
    this.sceneEl.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
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
      const number = document.createElement("div");
      number.className = "ntbk-page-number";
      number.textContent = String(page.index + 1);
      el.appendChild(number);

      this.pagesEl.appendChild(el);
    }
  }

  renderAll() {
    this.ink.clear();
    this.objects.clear();
    for (const stroke of this.store.strokes) this.ink.render(stroke);
    for (const object of this.store.objects) this.objects.render(object);
    this.index.rebuild(this.store.strokes);
  }

  _onChange(change) {
    if (change.type === "pages") {
      this.renderPages();
      this.host.dispatchEvent(new CustomEvent("scene:changed", { detail: change }));
      return;
    }

    if (change.type === "reload") {
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
