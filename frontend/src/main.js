import "./styles/app.css";

import { Store, createEmptyDocument, createPage, createLayer, ensureLayers,
         SCHEMA_VERSION, createStroke } from "./model/document.js";
import { newId } from "./model/ids.js";
import { History, addElements, removeElements, patchElements, setPages,
         setLayersCommand } from "./model/history.js";
import { Scene } from "./canvas/Scene.js";
import { SelectionController } from "./canvas/SelectionController.js";
import { ScrollBars } from "./canvas/ScrollBars.js";
import { PenTool } from "./tools/PenTool.js";
import { SelectTool, hitTestAt } from "./tools/SelectTool.js";
import { EraserTool } from "./tools/EraserTool.js";
import { ShapeTool, SHAPE_KINDS, SHAPE_LABELS } from "./tools/ShapeTool.js";
import { buildRibbon } from "./ui/Ribbon.js";
import { openContextMenu, closeContextMenu } from "./ui/ContextMenu.js";
import { openInspector, closeInspector } from "./ui/Inspector.js";
import { VIEW_PRESETS } from "./graph/GraphRenderer.js";
import { ObjectPanel } from "./ui/ObjectPanel.js";
import { bridge } from "./bridge.js";
import { createLatexObject } from "./objects/LatexBox.js";
import { createImageObject } from "./objects/ImageBox.js";
import { createPdfPageObject } from "./objects/PdfPage.js";
import { PdfService } from "./pdf/PdfService.js";
import { createGraphObject, GraphEditor } from "./objects/GraphBox.js";
import { createCodeObject } from "./objects/CodeCell.js";
import { createTextObject, DEFAULT_TEXT_SIZE } from "./objects/TextBox.js";
import { Ruler } from "./tools/Ruler.js";
import { renderPageToPng } from "./export/renderPage.js";
import { TextTool } from "./tools/TextTool.js";
import { openPdfDialog } from "./ui/PdfDialog.js";
import { AssetStore } from "./model/assets.js";

class App {
  constructor(root) {
    this.host = root.querySelector("#canvas-host");
    this.store = new Store(createEmptyDocument());
    this.history = new History(this.store);

    this.settings = {
      pen: {
        color: "#111111", size: 3, opacity: 1,
        thinning: 0.6,
        smoothing: 0.5,
        // Streamline pulls the curve toward the average of recent points.
        // High values look calm on long sweeps but lag the nib and round off
        // corners, so handwriting stops matching what you actually wrote.
        streamline: 0.32,
        taperStart: 0, taperEnd: 12, blend: "normal",
      },
      highlighter: {
        // A marker doesn't taper and doesn't thin with pressure
        color: "#ffe14d", size: 22, opacity: 0.45,
        thinning: 0, smoothing: 0.6, streamline: 0.6,
        taperStart: 0, taperEnd: 0, blend: "multiply",
        simulatePressure: false,
      },
      // Diameter, in scene units — the slider in the ribbon sets it
      eraser: { size: 24 },
      shape: { color: "#111111", size: 2.5 },
    };

    this.assets = new AssetStore();
    this.pdf = new PdfService();
    this.scene = new Scene(this.host, this.store, {
      assets: this.assets,
      pdf: this.pdf,
      scale: () => this.scene.scale,
      editGraph: (id) => this.editGraph(id),
      // True while a handle is being dragged. Objects that are expensive to
      // draw use it to stretch what they already have instead of rebuilding
      // on every frame.
      isTransforming: () => this.transforming,
      languageName: (filename) => this.languageName(filename),
      languages: () => this.languages,
      reloadLanguages: () => this.loadLanguages(),
      updateObjectPayload: (id, payload) => this.updateObjectPayload(id, payload),
    });

    this.selection = new Set();
    this.transforming = false;
    this.selectionController = new SelectionController(this);
    this.scrollBars = new ScrollBars(this);

    this.tools = {
      select: new SelectTool(this),
      text: new TextTool(this),
      pen: new PenTool(this, "pen"),
      highlighter: new PenTool(this, "highlighter"),
      eraser_stroke: new EraserTool(this, "stroke"),
      eraser_partial: new EraserTool(this, "partial"),
      ...Object.fromEntries(
        SHAPE_KINDS.map((kind) => [`shape_${kind}`, new ShapeTool(this, kind)])),
    };
    this.tool = null;

    root.querySelector("#ribbon").appendChild(buildRibbon(this));
    this.panel = new ObjectPanel(this, root.querySelector("#object-panel"));
    // Lives in the status bar beside the page indicator rather than up in the
    // ribbon — it belongs with the thing it counts
    document.querySelector("#add-page").addEventListener("click", () => this.addPage());
    this._bindPointer();
    this._bindKeyboard();
    this._bindMedia();

    this.history.subscribe(() => this._updateStatus());
    this.store.subscribe(() => this._updateStatus());
    this.host.addEventListener("scene:transform", () => {
      this._updateStatus();
      this._restyleForZoom();
    });
    this.host.addEventListener("scene:reload", () => {
      // A different document: whatever was being inspected is gone
      closeInspector();
      this.setSelection([]);
    });

    this.ruler = new Ruler(this);

    this.languages = {};
    this.loadLanguages();

    this.setTool("pen");
    this._wirePageInput();
    this._updateStatus();
    this._openLaunchDocument();
  }

  /** Load the notebook this window was launched with, if there was one. */
  async _openLaunchDocument() {
    await bridge.whenReady();
    const opened = await bridge.pendingOpen();
    if (!opened) return;
    const { data, assets } = opened;
    if (data.format !== "ntbk") return;
    this.pdf.clear();
    this.assets.load(data.assets ?? [], assets);
    this.store.replaceDocument(data);
    this.history.clear();
    this.setSelection([]);
    this._syncTitle();
  }

  // ── Tools ─────────────────────────────────
  setTool(name) {
    if (this.tool) this.tool.onCancel?.();
    this.scene.clearChrome();
    this.tool = this.tools[name];
    this.toolName = name;
    if (name !== "select") this.setSelection([]);
    this.host.style.cursor = this.tool.cursor ?? "default";
    for (const button of document.querySelectorAll("[data-tool]")) {
      // Both eraser modes light up the one Eraser button
      const family = (value) => {
        if (value.startsWith("eraser")) return "eraser";
        if (value.startsWith("shape_")) return "shape";
        return value;
      };
      button.classList.toggle("is-active",
        family(button.dataset.tool) === family(name));
    }
    this._updateStatus();
  }

  hitTest(point) {
    return hitTestAt(this, point);
  }

  /**
   * Can this element be clicked, selected or erased?
   *
   * One rule in one place: an element is out of reach if it or its layer is
   * hidden or locked. Locking is what lets you annotate a PDF printout
   * without nudging it.
   */
  isInteractive(element) {
    if (!element || element.visible === false || element.locked) return false;
    const layer = this.store.data.canvas.layers
      ?.find((l) => l.id === (element.layerId ?? this.store.data.canvas.layers[0]?.id));
    return !layer || (layer.visible !== false && !layer.locked);
  }

  activeLayerId() {
    const layers = this.store.data.canvas.layers ?? [];
    const chosen = layers.find((l) => l.id === this._activeLayerId);
    return (chosen ?? layers.find((l) => !l.locked && l.visible !== false) ?? layers[0])?.id;
  }

  // ── Selection ─────────────────────────────
  setSelection(ids) {
    this.selection = new Set(ids);
    this.scene.ink.setHighlighted(this.selection);
    this.scene.objects.setHighlighted(this.selection);
    this.selectionController.refresh();
    this.panel?.markSelection();
    this._updateStatus();
  }

  selectedStrokes() {
    return [...this.selection].filter((id) => this.store.isStroke(id));
  }

  deleteSelection() {
    if (!this.selection.size) return;
    this.history.run(removeElements(this.store, [...this.selection], "Delete"));
    this.setSelection([]);
  }

  // ── Styling ───────────────────────────────
  /** Restyles the selection when there is one, otherwise sets the default. */
  applyStyle(kind, patch) {
    const ids = this.selectedStrokes();
    if (ids.length) {
      const entries = ids.map((id) => {
        const stroke = this.store.find(id);
        return {
          id,
          before: { style: { ...stroke.style } },
          after: { style: { ...stroke.style, ...patch } },
        };
      });
      this.history.run(patchElements(entries, "Restyle"));
      this.selectionController.refresh();
      return;
    }
    Object.assign(this.settings[kind], patch);
  }

  /**
   * Stamp a new element with the layer it belongs to and a name for the
   * panel. Everything created anywhere goes through here.
   */
  adopt(element) {
    element.layerId = element.layerId ?? this.activeLayerId();
    // Objects and shapes get a name, because the panel lists them. Freehand ink
    // never does: it isn't listed, and naming every stroke would bloat the file.
    const listed = !element.kind || element.kind === "shape";
    if (listed && !element.name) element.name = this.autoName(element);
    return element;
  }

  autoName(element) {
    // Shapes are strokes, but to you they're objects, so they get numbered
    // names of their own: Rect 1, Rect 2, Ellipse 1.
    if (element.kind === "shape") {
      const label = String(element.shape ?? "shape").replace(/^./, (c) => c.toUpperCase());
      const used = this.store.strokes.filter((s) => s.shape === element.shape).length;
      return `${label} ${used + 1}`;
    }

    const label = {
      latex: "Formula", image: "Image", pdfpage: "PDF page",
      graph: "Plot", code: "Code", text: "Text",
    }[element.type] ?? "Object";

    if (element.type === "code" && element.payload?.filename) {
      return element.payload.filename;
    }
    const used = this.store.objects.filter((o) => o.type === element.type).length;
    return `${label} ${used + 1}`;
  }

  // ── Panel support ─────────────────────────
  /** Which page an element actually sits on, worked out from its position. */
  pageContaining(element) {
    const bounds = element.kind
      ? this.selectionController.boundsOf([element.id])
      : { minX: element.x, minY: element.y,
          maxX: element.x + element.w, maxY: element.y + element.h };
    if (!bounds) return null;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    return (this.store.data.canvas.pages ?? []).find(
      (p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h) ?? null;
  }

  /**
   * A panel row can stand for several elements — a placed custom shape is
   * many strokes but one object — so everything here takes a SET of ids.
   */
  selectFromPanel(ids, additive) {
    const wanted = asIds(ids);
    this.setTool("select");
    this.setSelection(additive
      ? [...new Set([...this.selection, ...wanted])]
      : wanted);
  }

  /**
   * Bring up whatever "properties" means for this element: an object opens its
   * own editor, a shape gets the same menu a right-click would give it.
   */
  editElement(id, anchor) {
    const element = this.store.find(id);
    if (!element || !this.isInteractive(element)) return;

    const node = this.scene.objects.elementFor(id);
    if (node) {
      // The same event the canvas double-click sends, so there is one path in
      node.dispatchEvent(new CustomEvent("ntbk:edit"));
      return;
    }

    const rect = anchor?.getBoundingClientRect?.();
    openContextMenu(this, rect ? rect.right + 6 : 120, rect ? rect.top : 120);
  }

  /** Right-click in the tree: the full picture of one element. */
  inspectElement(id, anchor) {
    closeContextMenu();
    openInspector(this, id, anchor);
  }

  /**
   * Single click in the tree: say where it is, without going there.
   *
   * The selection outline already marks it when it's on screen. When it's
   * pages away that outline is invisible, so the page number and a pointer at
   * the edge of the viewport are what actually answer "where is it".
   */
  locateElement(ids) {
    const wanted = asIds(ids);
    const element = this.store.find(wanted[0]);
    if (!element) return;
    const page = this.pageContaining(element);
    const name = element.name ?? "Item";
    this._flash(page ? `${name} — page ${page.index + 1}` : `${name} — off-page`);
    this._pointAt(wanted);
  }

  _pointAt(ids) {
    const wanted = asIds(ids);
    this._clearLocator();
    const bounds = this.selectionController.boundsOf(wanted);
    if (!bounds) return;

    const rect = this.host.getBoundingClientRect();
    const scale = this.scene.scale;
    const cx = ((bounds.minX + bounds.maxX) / 2) * scale + this.scene.view.x;
    const cy = ((bounds.minY + bounds.maxY) / 2) * scale + this.scene.view.y;
    // On screen already: the selection outline is the better marker
    if (cx >= 0 && cx <= rect.width && cy >= 0 && cy <= rect.height) return;

    const margin = 30;
    const x = Math.min(Math.max(cx, margin), rect.width - margin);
    const y = Math.min(Math.max(cy, margin), rect.height - margin);

    const el = document.createElement("div");
    el.className = "ntbk-locator";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.setProperty("--angle", `${(Math.atan2(cy - y, cx - x) * 180) / Math.PI}deg`);
    const page = this.pageContaining(this.store.find(wanted[0]));
    el.textContent = page ? String(page.index + 1) : "?";
    this.host.appendChild(el);

    this._locator = el;
    // Panning or zooming moves what it points at, so it can't outlive that
    this._clearLocatorOn = () => this._clearLocator();
    this.host.addEventListener("scene:transform", this._clearLocatorOn, { once: true });
    this._locatorTimer = setTimeout(() => this._clearLocator(), 3000);
  }

  _clearLocator() {
    clearTimeout(this._locatorTimer);
    if (this._clearLocatorOn) {
      this.host.removeEventListener("scene:transform", this._clearLocatorOn);
      this._clearLocatorOn = null;
    }
    this._locator?.remove();
    this._locator = null;
  }

  /** Double-click in the tree: go to it, wherever it is, and select it. */
  goToElement(ids) {
    const wanted = asIds(ids);
    const element = this.store.find(wanted[0]);
    if (!element) return;
    this._clearLocator();
    const bounds = this.selectionController.boundsOf(wanted);
    if (!bounds) return;

    const rect = this.host.getBoundingClientRect();
    const scale = this.scene.scale;
    this.scene.view.x = rect.width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
    this.scene.view.y = rect.height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale;
    this.scene._applyView();
    this.scene._emitTransform();

    this.setTool("select");
    this.setSelection(wanted);
    const page = this.pageContaining(element);
    if (page) this._flash(`Page ${page.index + 1}`);
  }

  /** Outline an element while its row is hovered in the tree. */
  highlightElement(ids) {
    for (const node of this.host.querySelectorAll(".is-peeked")) {
      node.classList.remove("is-peeked");
    }
    if (!ids) return;
    for (const id of asIds(ids)) {
      const element = this.store.find(id);
      if (!element) continue;
      const node = element.kind
        ? this.host.querySelector(`.ntbk-ink path[data-id="${id}"]`)
        : this.scene.objects.elementFor(id);
      node?.classList.add("is-peeked");
    }
  }

  setElementFlag(ids, key, value) {
    const wanted = asIds(ids).filter((id) => this.store.find(id));
    if (!wanted.length) return;
    const label = key === "visible"
      ? (value ? "Show" : "Hide")
      : (value ? "Lock" : "Unlock");
    // Every piece of a group flips together, as one undo step
    this.history.run(patchElements(wanted.map((id) => ({
      id,
      before: { [key]: this.store.find(id)[key] },
      after: { [key]: value },
    })), label));
    // Hidden or locked elements must not stay selected
    this.setSelection([...this.selection].filter(
      (id) => this.isInteractive(this.store.find(id))));
  }

  renameElement(ids, name) {
    const wanted = asIds(ids).filter((id) => this.store.find(id));
    if (!wanted.length) return;
    // Renaming a group renames every piece, so they stay one thing
    this.history.run(patchElements(wanted.map((id) => ({
      id,
      before: { name: this.store.find(id).name },
      after: { name },
    })), "Rename"));
  }

  // ── Layers ────────────────────────────────
  addLayer() {
    const layers = this.store.data.canvas.layers ?? [];
    const next = [...layers, createLayer(`Layer ${layers.length + 1}`)];
    // Claim it BEFORE the command runs: the store change is what repaints the
    // panel, so setting this afterwards leaves the old layer looking active.
    this._activeLayerId = next[next.length - 1].id;
    this.history.run(setLayersCommand(layers, next, "Add layer"));
  }

  setActiveLayer(id) {
    this._activeLayerId = id;
    this._flash(`Drawing on ${this.store.data.canvas.layers.find((l) => l.id === id)?.name}`);
    this.panel?.render();
  }

  setLayerFlag(id, key, value) {
    const layers = this.store.data.canvas.layers ?? [];
    const next = layers.map((l) => (l.id === id ? { ...l, [key]: value } : l));
    const label = key === "visible"
      ? (value ? "Show layer" : "Hide layer")
      : (value ? "Lock layer" : "Unlock layer");
    this.history.run(setLayersCommand(layers, next, label));
    // Hiding or locking a layer takes everything on it out of reach
    this.setSelection([...this.selection].filter(
      (id) => this.isInteractive(this.store.find(id))));
  }

  /** Move the selection onto a layer. */
  moveSelectionToLayer(layerId) {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.history.run(patchElements(
      ids.map((id) => ({
        id,
        before: { layerId: this.store.find(id).layerId },
        after: { layerId },
      })), "Change layer"));
    this.scene.renderAll();
  }

  // ── Transforms ────────────────────────────
  /**
   * Apply a geometric change to the whole selection, about its own centre.
   *
   * Strokes have their points moved; objects keep their geometry and get a
   * rotation or flip flag instead, because rewriting a LaTeX box or a code
   * cell point by point is meaningless.
   */
  _transformSelection(label, forStroke, forObject) {
    const ids = [...this.selection];
    if (!ids.length) return;
    const bounds = this.selectionController.boundsOf(ids);
    if (!bounds) return;

    const centre = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };

    const entries = [];
    for (const id of ids) {
      const element = this.store.find(id);
      if (!element) continue;

      if (element.kind) {
        const points = element.points.slice();
        for (let i = 0; i < points.length; i += element.stride) {
          const moved = forStroke(points[i], points[i + 1], centre);
          points[i] = moved.x;
          points[i + 1] = moved.y;
        }
        entries.push({
          id,
          before: { points: element.points.slice() },
          after: { points },
        });
      } else {
        const changes = forObject(element, centre);
        if (!changes) continue;
        const before = {};
        for (const key of Object.keys(changes)) before[key] = element[key];
        entries.push({ id, before, after: changes });
      }
    }

    if (!entries.length) return;
    this.history.run(patchElements(entries, label));
    this.selectionController.refresh();
  }

  rotateSelection(degrees) {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    this._transformSelection(
      `Rotate ${degrees}°`,
      (x, y, c) => ({
        x: c.x + (x - c.x) * cos - (y - c.y) * sin,
        y: c.y + (x - c.x) * sin + (y - c.y) * cos,
      }),
      (object, c) => {
        // The object turns on the spot, and its centre swings around the
        // selection's centre — so a group rotates as a group
        const ox = object.x + object.w / 2;
        const oy = object.y + object.h / 2;
        const nx = c.x + (ox - c.x) * cos - (oy - c.y) * sin;
        const ny = c.y + (ox - c.x) * sin + (oy - c.y) * cos;
        return {
          x: nx - object.w / 2,
          y: ny - object.h / 2,
          rotation: ((object.rotation ?? 0) + degrees) % 360,
        };
      });
  }

  flipSelection(axis) {
    const horizontal = axis === "x";
    this._transformSelection(
      horizontal ? "Flip horizontal" : "Flip vertical",
      (x, y, c) => ({
        x: horizontal ? 2 * c.x - x : x,
        y: horizontal ? y : 2 * c.y - y,
      }),
      (object, c) => {
        const ox = object.x + object.w / 2;
        const oy = object.y + object.h / 2;
        const changes = horizontal
          ? { x: 2 * c.x - ox - object.w / 2 }
          : { y: 2 * c.y - oy - object.h / 2 };
        // Mirroring the contents only makes sense for a picture. Flipping a
        // code cell or a formula would just make it unreadable, so those
        // move within the selection without being mirrored themselves.
        if (object.type === "image") {
          changes[horizontal ? "flipX" : "flipY"] =
            !(object[horizontal ? "flipX" : "flipY"]);
        }
        return changes;
      });
  }

  /** Live restyle while a slider moves — not recorded until it settles. */
  previewStyle(patch) {
    const ids = this.selectedStrokes();
    if (!ids.length) return;
    this.store.patchMany(ids.map((id) => {
      const stroke = this.store.find(id);
      return { id, changes: { style: { ...stroke.style, ...patch } } };
    }));
    this.selectionController.refresh();
  }

  // ── Pages ─────────────────────────────────
  addPage() {
    const before = this.store.data.canvas.pages;
    const page = createPage(before);
    this.history.run(setPages(before, [...before, page], "Add page"));
    this.scrollToPage(page);
    this._flash(`Added page ${page.index + 1}`);
  }

  /** Bring a page into view, top edge just below the ribbon. */
  /** Type a page number in the status bar to go there. */
  _wirePageInput() {
    const input = document.querySelector("#status-page-input");
    if (!input) return;
    const go = () => {
      const pages = this.store.data.canvas.pages;
      const wanted = Number.parseInt(input.value, 10);
      if (!Number.isFinite(wanted)) { this._updateStatus(); return; }
      // Out of range snaps to the nearest real page rather than refusing
      const index = Math.min(Math.max(wanted, 1), pages.length) - 1;
      this.scrollToPage(pages[index]);
      // Write the corrected number back here rather than leaving it to the
      // status refresh: type 99 in a 5-page file and the box has to say 5,
      // whatever the focus happens to be doing
      input.value = String(index + 1);
      this._updateStatus();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();          // digits must never reach the canvas
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") { this._updateStatus(); input.blur(); }
    });
    input.addEventListener("blur", go);
    input.addEventListener("focus", () => input.select());
  }

  scrollToPage(page) {
    const rect = this.host.getBoundingClientRect();
    const scale = this.scene.scale;
    this.scene.view.x = rect.width / 2 - (page.x + page.w / 2) * scale;
    this.scene.view.y = 24 - page.y * scale;
    this.scene._applyView();
    this.scene._emitTransform();
  }

  /**
   * Which page you're looking at: the one under the middle of the viewport,
   * or the nearest one when the middle lands in the gutter between pages.
   */
  currentPage() {
    const pages = this.store.data.canvas.pages;
    if (!pages.length) return null;

    const rect = this.host.getBoundingClientRect();
    const centre = this.scene.toScene(
      rect.left + rect.width / 2, rect.top + rect.height / 2);

    const inside = pages.find((p) =>
      centre.x >= p.x && centre.x <= p.x + p.w
      && centre.y >= p.y && centre.y <= p.y + p.h);
    if (inside) return inside;

    let nearest = pages[0];
    let best = Infinity;
    for (const p of pages) {
      const distance = Math.abs(centre.y - (p.y + p.h / 2));
      if (distance < best) { best = distance; nearest = p; }
    }
    return nearest;
  }

  // ── Objects ───────────────────────────────
  insertLatex() {
    const rect = this.host.getBoundingClientRect();
    const centre = this.scene.toScene(
      rect.left + rect.width / 2, rect.top + rect.height / 3);
    const object = createLatexObject(Math.round(centre.x - 120), Math.round(centre.y - 48));
    this.history.run(addElements([this.adopt(object)], "Insert LaTeX"));
    this.setTool("select");
    this.setSelection([object.id]);
  }

  /** Bring media in from a file picker, a paste or a drop. */
  async insertImage(files) {
    const picked = files ?? await bridge.pickFiles({ accept: "image/*", multiple: true });
    const images = picked.filter((f) => f.mime.startsWith("image/"));
    if (!images.length) return;

    const created = [];
    for (const file of images) {
      const asset = this.assets.add(file.bytes, file.mime);
      const size = await measureImage(asset.url);

      // Land at a readable size: no wider than half the viewport, and never
      // blown up past its own resolution.
      //
      // "Its own resolution" has to be measured in DEVICE pixels. Capping at
      // one image pixel per CSS pixel still stretches every image 2x on a
      // Retina screen, which is exactly what made imported pictures look
      // soft next to the crisp vector ink beside them.
      const rect = this.host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const maxWidth = (rect.width * 0.5) / this.scene.scale;
      const scale = Math.min(1 / dpr, maxWidth / size.width);
      const w = Math.round(size.width * scale);
      const h = Math.round(size.height * scale);

      const centre = this.scene.toScene(
        rect.left + rect.width / 2, rect.top + rect.height / 2);
      created.push(createImageObject({
        assetId: asset.id, mime: file.mime,
        x: Math.round(centre.x - w / 2) + created.length * 24,
        y: Math.round(centre.y - h / 2) + created.length * 24,
        w, h, naturalW: size.width, naturalH: size.height,
      }));
    }

    this.history.run(addElements(created.map((o) => this.adopt(o)), created.length > 1 ? "Insert images" : "Insert image"));
    this.setTool("select");
    this.setSelection(created.map((o) => o.id));
  }

  /** OneNote-style file printout: pick a PDF, choose pages, drop them in. */
  async insertPdf() {
    if (!this.pdf.available) {
      return this._flash("PDF insert needs the desktop app, not the browser");
    }
    const [file] = await bridge.pickFiles({ accept: "application/pdf" });
    if (!file) return;

    const asset = this.assets.add(file.bytes, "application/pdf");
    let pageCount;
    try {
      pageCount = await this.pdf.pageCount(asset.id, asset.bytes);
    } catch {
      this.assets.items.delete(asset.id);
      return this._flash("Could not read that PDF");
    }

    openPdfDialog({
      fileName: file.name,
      pageCount,
      renderThumb: (page) =>
        this.pdf.renderPage(asset.id, asset.bytes, page, 120, 1).catch(() => null),
      onInsert: (pages, placement) =>
        this._placePdfPages(asset, file.name, pages, placement),
    });
  }

  async _placePdfPages(asset, fileName, pages, placement) {
    const sizes = await Promise.all(
      pages.map((page) => this.pdf.pageSize(asset.id, asset.bytes, page)));

    const created = [];
    const canvas = this.store.data.canvas;

    if (placement === "pages") {
      // One PDF page per notebook page, appended at the end and fitted to
      // the page width — the way you'd annotate a handout end to end
      const before = canvas.pages;
      const added = [];
      let pageList = [...before];
      for (let i = 0; i < pages.length; i++) {
        const sheet = createPage(pageList);
        pageList = [...pageList, sheet];
        added.push(sheet);
      }
      this.history.run(setPages(before, pageList, "Add pages for PDF"));

      pages.forEach((page, i) => {
        const sheet = added[i];
        const size = sizes[i];
        const margin = 24;
        const scale = Math.min((sheet.w - margin * 2) / size.width,
                               (sheet.h - margin * 2) / size.height);
        const w = Math.round(size.width * scale);
        const h = Math.round(size.height * scale);
        created.push(createPdfPageObject({
          assetId: asset.id, pageNumber: page, source: fileName,
          x: Math.round(sheet.x + (sheet.w - w) / 2),
          y: Math.round(sheet.y + (sheet.h - h) / 2),
          w, h,
        }));
      });
    } else {
      // Stacked where you are, floating like any other object
      const rect = this.host.getBoundingClientRect();
      const topLeft = this.scene.toScene(rect.left + rect.width * 0.2, rect.top + 40);
      const targetWidth = Math.min(620, (rect.width * 0.6) / this.scene.scale);
      let y = topLeft.y;

      pages.forEach((page, i) => {
        const size = sizes[i];
        const w = Math.round(targetWidth);
        const h = Math.round((size.height / size.width) * w);
        created.push(createPdfPageObject({
          assetId: asset.id, pageNumber: page, source: fileName,
          x: Math.round(topLeft.x), y: Math.round(y), w, h,
        }));
        y += h + 20;
      });
    }

    this.history.run(addElements(created.map((o) => this.adopt(o)),
      `Insert ${created.length} PDF page${created.length === 1 ? "" : "s"}`));

    if (placement === "pages" && canvas.pages.length) {
      this.scrollToPage(canvas.pages[canvas.pages.length - pages.length]);
    }
    this.setTool("select");
    this.setSelection([]);
    this._flash(`Inserted ${created.length} page${created.length === 1 ? "" : "s"} from ${fileName}`);
  }

  /**
   * Drop a text box at a point, snapped to the page's grid.
   *
   * Free placement to the exact pixel makes it impossible to line two
   * paragraphs up. Snapping to the same grid the page already draws gives
   * the discrete feel of a text editor, and you can still drag it anywhere
   * afterwards.
   */
  insertText(point) {
    const snapped = this.snapToGrid(point);
    const object = createTextObject(snapped.x, snapped.y);
    this.history.run(addElements([this.adopt(object)], "Add text"));
    this.setTool("select");
    this.setSelection([object.id]);
    // Give it the caret straight away — you clicked to type
    requestAnimationFrame(() => this.objectHandle(object.id)?.focus?.());
    return object;
  }

  /** Nearest grid intersection on the page under a point. */
  snapToGrid(point) {
    const background = this.store.data.canvas.background ?? {};
    const step = background.spacing > 4 ? background.spacing : 20;
    const page = (this.store.data.canvas.pages ?? []).find(
      (p) => point.x >= p.x && point.x <= p.x + p.w
          && point.y >= p.y && point.y <= p.y + p.h);
    const originX = page?.x ?? 0;
    const originY = page?.y ?? 0;
    return {
      x: originX + Math.round((point.x - originX) / step) * step,
      y: originY + Math.round((point.y - originY) / step) * step,
    };
  }

  // ── Custom shapes ─────────────────────────
  /**
   * Save whatever is selected as a reusable shape.
   *
   * Stored normalised to a unit box so it can be dropped at any size later,
   * and as a LIST of strokes so a multi-part drawing keeps its colours.
   * Placing one selects every part, so it moves and deletes as one thing.
   */
  async saveSelectionAsShape(name) {
    const ids = this.selectedStrokes();
    if (!ids.length) return this._flash("Select some strokes first");

    const bounds = this.selectionController.boundsOf(ids);
    if (!bounds) return this._flash("Nothing measurable in that selection");
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);

    const strokes = ids.map((id) => {
      const stroke = this.store.find(id);
      const points = [...stroke.points];
      // Normalise into 0..1 so the shape scales to whatever box it lands in
      for (let i = 0; i < points.length; i += stroke.stride) {
        points[i] = (points[i] - bounds.minX) / width;
        points[i + 1] = (points[i + 1] - bounds.minY) / height;
      }
      return { kind: stroke.kind, shape: stroke.shape, stride: stroke.stride,
               points, style: { ...stroke.style } };
    });

    const result = await bridge.saveShape(name, {
      name, aspect: width / height, strokes,
    });
    if (result?.ok) {
      this._flash(`Saved "${result.name}" \u2014 it's in the Shapes menu`);
      await this.loadShapes();
    } else {
      this._flash(result?.error ?? "Could not save that shape");
    }
  }

  async loadShapes() {
    this.customShapes = await bridge.listShapes();
    return this.customShapes;
  }

  /** Drop a saved shape onto the page, sized to a sensible default. */
  placeCustomShape(entry, size = 160) {
    const shape = entry.shape ?? entry;
    const rect = this.host.getBoundingClientRect();
    const centre = this.scene.toScene(
      rect.left + rect.width / 2, rect.top + rect.height / 2);
    const aspect = shape.aspect || 1;
    const width = size;
    const height = size / aspect;
    const originX = centre.x - width / 2;
    const originY = centre.y - height / 2;

    // One id shared by every piece: that is what makes the panel show a
    // placed shape as a single object instead of a pile of loose strokes
    const groupId = newId("gr");

    const created = shape.strokes.map((template) => {
      const points = [...template.points];
      for (let i = 0; i < points.length; i += template.stride) {
        points[i] = originX + points[i] * width;
        points[i + 1] = originY + points[i + 1] * height;
      }
      return this.adopt(createStroke({
        kind: template.kind ?? "shape",
        shape: template.shape,
        points,
        style: { ...template.style },
        name: shape.name,
        groupId,
      }));
    });

    this.history.run(addElements(created, `Place ${shape.name}`));
    this.setTool("select");
    this.setSelection(created.map((stroke) => stroke.id));
    return created;
  }

  /** A second notebook beside this one, with its own document and terminals. */
  async newWindow() {
    const result = await bridge.newWindow();
    if (!result?.ok) this._flash(result?.error ?? "Could not open a window");
  }

  /** Keep the window named after the document it holds. */
  _syncTitle() {
    bridge.setTitle(this.store.data.meta?.title || "untitled");
  }

  // ── Export ────────────────────────────────
  /**
   * Render every page and bind them into a PDF.
   *
   * `print` hands the finished file straight to the system viewer, which is
   * where the real print dialogue lives — the student gets their own printer
   * list and "Save as PDF" without us reimplementing either.
   */
  async exportPdf({ print = false, clipToMargins = false } = {}) {
    const pages = this.store.data.canvas.pages ?? [];
    if (!pages.length) return this._flash("Nothing to export");

    // The ruler is an instrument, not content — it must never print
    const rulerWasOut = this.ruler.visible;
    if (rulerWasOut) this.ruler.hide();
    const hadSelection = [...this.selection];
    this.setSelection([]);

    this._flash(print ? "Preparing to print\u2026" : "Building the PDF\u2026");
    try {
      const rendered = [];
      for (const page of pages) {
        rendered.push({ png: await renderPageToPng(this, page, undefined, { clipToMargins }) });
      }
      const name = `${this.store.data.meta.title || "untitled"}.pdf`;
      const result = await bridge.exportPdf(rendered, name, print);
      if (result?.cancelled) this._flash("Cancelled");
      else if (result?.ok) {
        // Say WHERE it went. "Saved" on its own is how a file gets lost.
        const where = String(result.path ?? "").split("/").slice(-2).join("/");
        this._flash(print
          ? `Sent ${result.pages} page${result.pages === 1 ? "" : "s"} to print \u2014 ${where}`
          : `Saved ${result.pages} page${result.pages === 1 ? "" : "s"} \u2192 ${where}`);
      } else {
        this._flash(result?.error ?? "Could not write the PDF");
      }
    } catch (error) {
      this._flash(`Export failed: ${error.message}`);
    } finally {
      if (rulerWasOut) this.ruler.show();
      if (hadSelection.length) this.setSelection(hadSelection);
    }
  }

  // ── Instruments ───────────────────────────
  /** The ruler is an instrument, not content: never saved, gone when hidden. */
  toggleRuler() {
    const on = this.ruler.toggle();
    this._flash(on ? "Ruler out \u2014 ink snaps to its edge" : "Ruler away");
    this._syncRulerButton();
    return on;
  }

  setRulerLength(cm) {
    this.ruler.lengthCm = Math.min(100, Math.max(5, Number(cm) || 30));
    this.ruler._buildTicks();
    this.ruler.place();
  }

  _syncRulerButton() {
    const button = document.querySelector('[data-action="ruler"]');
    button?.classList.toggle("is-active", this.ruler.visible);
  }

  /** Bold the current text selection, if a text box has the caret. */
  toggleTextBold() {
    for (const id of this.selection) {
      this.objectHandle(id)?.toggleBold?.();
    }
  }

  insertCode(filename = "untitled.py") {
    const rect = this.host.getBoundingClientRect();
    const centre = this.scene.toScene(
      rect.left + rect.width / 2, rect.top + rect.height / 2);
    const object = createCodeObject(
      Math.round(centre.x - 280), Math.round(centre.y - 190), filename);
    this.history.run(addElements([this.adopt(object)], "Insert code cell"));
    this.setTool("select");
    this.setSelection([object.id]);
  }

  /** Ask Python which languages this machine can run, once it is reachable. */
  async loadLanguages() {
    await bridge.whenReady();
    this.languages = (await bridge.codeLanguages()) ?? {};
    // Cells mounted before the answer arrived are showing no default command
    for (const object of this.store.objects) {
      if (object.type === "code") this.scene.objects.render(object);
    }
  }

  languageName(filename) {
    const extension = (String(filename).match(/\.[^.]+$/) ?? [""])[0].toLowerCase();
    const entry = this.languages?.[extension];
    if (!entry) return "";
    return entry.available ? entry.name : `${entry.name} — not installed`;
  }

  insertGraph(kind = "function2d") {
    const rect = this.host.getBoundingClientRect();
    const centre = this.scene.toScene(
      rect.left + rect.width / 2, rect.top + rect.height / 2);
    const object = createGraphObject(0, 0, kind);
    object.x = Math.round(centre.x - object.w / 2);
    object.y = Math.round(centre.y - object.h / 2);
    this.history.run(addElements([this.adopt(object)], "Insert plot"));
    this.setTool("select");
    this.setSelection([object.id]);
    this.editGraph(object.id);
  }

  editGraph(id) {
    const object = this.store.find(id);
    if (!object || object.type !== "graph") return;
    this.graphEditor?.destroy();
    this.graphEditor = new GraphEditor(this, object);
  }

  updateObjectPayload(id, payload, label = "Edit contents") {
    const object = this.store.find(id);
    if (!object) return;
    this.history.run(patchElements(
      [{ id, before: { payload: object.payload }, after: { payload } }],
      label,
    ));
  }

  /** The live handle of a mounted object, for controls that drive it directly. */
  objectHandle(id) {
    return this.scene.objects.nodes.get(id)?.handle ?? null;
  }

  /** Apply a payload with no history entry — for live previews while typing. */
  previewObjectPayload(id, payload) {
    if (!this.store.find(id)) return;
    this.store.patchMany([{ id, changes: { payload } }]);
  }

  /** Record a payload edit that previews have already applied. */
  recordPayloadEdit(id, before, after, label = "Edit contents") {
    this.history.record(patchElements(
      [{ id, before: { payload: before }, after: { payload: after } }], label));
  }

  /** Swap a 3D plot to a named camera preset. */
  setPlotView(id, preset) {
    const object = this.store.find(id);
    if (!object?.payload) return;
    this.updateObjectPayload(id,
      { ...object.payload, view: { ...VIEW_PRESETS[preset] } }, "Change view");
  }

  /** Restyle one element by id, rather than whatever happens to be selected. */
  setElementStyle(id, patch) {
    const element = this.store.find(id);
    if (!element?.style) return;
    this.history.run(patchElements(
      [{ id, before: { style: { ...element.style } },
         after: { style: { ...element.style, ...patch } } }],
      "Restyle"));
    this.selectionController.refresh();
  }

  /** Resize or move one object by id. Strokes have no box to set. */
  setElementBox(id, patch) {
    const element = this.store.find(id);
    if (!element || element.kind) return;
    const before = {};
    const after = {};
    for (const key of Object.keys(patch)) {
      before[key] = element[key];
      after[key] = patch[key];
    }
    this.history.run(patchElements([{ id, before, after }],
      "w" in patch || "h" in patch ? "Resize" : "Move"));
    this.selectionController.refresh();
  }

  // ── Files ─────────────────────────────────
  newDocument() {
    this.assets.clear();
    this.pdf.clear();
    this.store.replaceDocument(createEmptyDocument());
    this.history.clear();
    this.setSelection([]);
    this._syncTitle();
  }

  async saveDocument() {
    const name = `${this.store.data.meta.title || "untitled"}.ntbk`;
    const document = this.store.toJSON();
    document.assets = this.assets.manifest();

    // Code cells are written out as real files next to the notebook
    const sources = {};
    for (const object of this.store.objects) {
      if (object.type === "code" && object.payload.filename) {
        sources[object.payload.filename] = object.payload.source ?? "";
      }
    }
    const saved = await bridge.saveDocument(
      document, this.assets.files(), name, sources);
    if (saved) {
      // The file may have been saved under a new name
      const stem = String(saved).split("/").pop().replace(/\.ntbk$/i, "");
      if (stem) this.store.data.meta.title = stem;
      this._syncTitle();
      this._flash(`Saved ${saved}`);
    }
  }

  async openDocument() {
    const opened = await bridge.openDocument();
    if (!opened) return;
    const { data, assets } = opened;
    if (data.format !== "ntbk") return this._flash("Not an .ntbk file");
    if (data.schemaVersion > SCHEMA_VERSION) {
      return this._flash(`File is schema v${data.schemaVersion}, this build reads v${SCHEMA_VERSION}`);
    }
    // Assets must land before the document, or the first render of an image
    // object looks up an id that isn't there yet
    this.pdf.clear();
    this.assets.load(data.assets ?? [], assets);
    this.store.replaceDocument(data);
    this.history.clear();
    this.setSelection([]);
    this._syncTitle();
    this._flash("Opened");
  }

  // ── Input ─────────────────────────────────
  _bindPointer() {
    let panning = null;

    // Selection handles sit inside #canvas-host, so a press on one bubbles
    // into the handler below. Left unguarded, the select tool sees a click on
    // nothing, clears the selection, and the handles vanish underneath the
    // gesture you just started.
    const isChrome = (event) => !!event.target?.closest?.(".ntbk-handle");

    this.host.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const point = this.scene.toScene(event.clientX, event.clientY);
      const hit = this.hitTest(point);
      // Right-clicking something not yet selected picks it first, so the
      // menu always acts on what you pointed at
      if (hit && !this.selection.has(hit)) {
        this.setTool("select");
        this.setSelection([hit]);
      }
      if (!this.selection.size) return;
      openContextMenu(this, event.clientX, event.clientY);
    });

    this.host.addEventListener("dblclick", (event) => {
      // Once selected, an object is covered by the selection chrome, so the
      // double-click that opens its editor has to be routed through by hand
      const id = this.hitTest(this.scene.toScene(event.clientX, event.clientY));
      const el = id ? this.scene.objects.elementFor(id) : null;
      if (el) el.dispatchEvent(new CustomEvent("ntbk:edit"));
    });

    this.host.addEventListener("pointerdown", (event) => {
      if (isChrome(event)) return;
      // Middle-drag or held space pans, whatever tool is active
      if (event.button === 1 || this.spaceHeld) {
        panning = { x: event.clientX, y: event.clientY };
        try { this.host.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
        event.preventDefault();
        return;
      }
      try { this.host.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
      this.tool?.onPointerDown?.(event, this.scene.toScene(event.clientX, event.clientY));
    });

    this.host.addEventListener("pointermove", (event) => {
      if (isChrome(event)) return;
      if (panning) {
        this.scene.panBy(event.clientX - panning.x, event.clientY - panning.y);
        panning = { x: event.clientX, y: event.clientY };
        this.selectionController.refresh();
        this.scrollBars.update();
        return;
      }
      this.tool?.onPointerMove?.(event, this.scene.toScene(event.clientX, event.clientY));
    });

    const end = (event) => {
      if (isChrome(event)) return;
      if (panning) { panning = null; return; }
      this.tool?.onPointerUp?.(event, this.scene.toScene(event.clientX, event.clientY));
    };
    this.host.addEventListener("pointerup", end);
    this.host.addEventListener("pointercancel", end);

    // Stops the iPad/trackpad from scrolling the page under the ink
    this.host.style.touchAction = "none";
  }

  _bindMedia() {
    window.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      Promise.all(files.map(async (f) => ({
        name: f.name, mime: f.type,
        bytes: new Uint8Array(await f.arrayBuffer()),
      }))).then((picked) => this.insertImage(picked));
    });

    // Dropping a file onto the canvas is the fastest way in
    this.host.addEventListener("dragover", (event) => event.preventDefault());
    this.host.addEventListener("drop", (event) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      Promise.all(files.map(async (f) => ({
        name: f.name, mime: f.type,
        bytes: new Uint8Array(await f.arrayBuffer()),
      }))).then((picked) => this.insertImage(picked));
    });
  }

  _bindKeyboard() {
    window.addEventListener("keydown", (event) => {
      const typing = /^(INPUT|TEXTAREA)$/.test(event.target?.tagName)
        || event.target?.isContentEditable;
      if (typing) return;

      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? this.history.redo() : this.history.undo();
        this.setSelection([...this.selection].filter((id) => this.store.find(id)));
        return;
      }
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        this.saveDocument();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        this.deleteSelection();
        return;
      }
      if (event.key === "Escape") { closeContextMenu(); this.setSelection([]); return; }
      if (event.key === " ") { this.spaceHeld = true; this.host.style.cursor = "grab"; }

      const shortcuts = { p: "pen", h: "highlighter", v: "select", s: "select",
                          e: "eraser_stroke" };
      if (!mod && shortcuts[event.key.toLowerCase()]) {
        this.setTool(shortcuts[event.key.toLowerCase()]);
      }
    });

    window.addEventListener("keyup", (event) => {
      if (event.key === " ") {
        this.spaceHeld = false;
        this.host.style.cursor = this.tool?.cursor ?? "default";
      }
    });
  }

  /**
   * Tell objects the zoom moved. PDF pages use it to re-rasterise sharper
   * when you go in close. Debounced, so a pinch doesn't queue a render a frame.
   */
  _restyleForZoom() {
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => {
      const scale = this.scene.scale;
      for (const node of this.scene.objects.nodes.values()) {
        node.handle?.onZoom?.(scale);
      }
    }, 180);
  }

  // ── Status bar ────────────────────────────
  _updateStatus() {
    const strokes = this.store.strokes.length;
    const objects = this.store.objects.length;
    document.querySelector("#status-tool").textContent =
      { pen: "Pen", highlighter: "Highlighter", select: "Select",
        eraser_stroke: "Eraser (stroke)", eraser_partial: "Eraser (partial)",
      }[this.toolName]
      ?? (this.toolName?.startsWith("shape_")
          ? SHAPE_LABELS[this.toolName.slice(6)] : "")
      ?? "";
    const pages = this.store.data.canvas.pages;
    const here = this.currentPage();
    const pageInput = document.querySelector("#status-page-input");
    // Never overwrite a number being typed
    if (pageInput && document.activeElement !== pageInput) {
      pageInput.value = here ? String(here.index + 1) : "";
    }
    document.querySelector("#status-page-total").textContent = ` of ${pages.length}`;

    document.querySelector("#status-counts").textContent =
      `${strokes} stroke${strokes === 1 ? "" : "s"} · ${objects} object${objects === 1 ? "" : "s"}`
      + (this.selection.size ? ` · ${this.selection.size} selected` : "");
    document.querySelector("#status-zoom").textContent =
      `${Math.round(this.scene.scale * 100)}%`;

    const undo = document.querySelector('[data-action="undo"]');
    const redo = document.querySelector('[data-action="redo"]');
    if (undo) undo.disabled = !this.history.canUndo;
    if (redo) redo.disabled = !this.history.canRedo;
  }

  _flash(message) {
    const el = document.querySelector("#status-hint");
    // Remember the real hint once, not whatever is on screen: two flashes in
    // quick succession would otherwise restore each other and the hint would
    // never come back.
    this._flashBase ??= el.textContent;
    el.textContent = message;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { el.textContent = this._flashBase; }, 2500);
  }
}

/** A panel row may stand for one element or a whole group. */
function asIds(value) {
  return Array.isArray(value) ? value : [value];
}

window.app = new App(document.querySelector("#app"));

/** Natural pixel size of an image, once the browser has decoded it. */
function measureImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 320, height: 240 });
    img.src = url;
  });
}
