import "./styles/app.css";

import { Store, createEmptyDocument, createPage, SCHEMA_VERSION } from "./model/document.js";
import { History, addElements, removeElements, patchElements, setPages } from "./model/history.js";
import { Scene } from "./canvas/Scene.js";
import { SelectionController } from "./canvas/SelectionController.js";
import { ScrollBars } from "./canvas/ScrollBars.js";
import { PenTool } from "./tools/PenTool.js";
import { SelectTool, hitTestAt } from "./tools/SelectTool.js";
import { EraserTool } from "./tools/EraserTool.js";
import { ShapeTool, SHAPE_KINDS, SHAPE_LABELS } from "./tools/ShapeTool.js";
import { buildRibbon } from "./ui/Ribbon.js";
import { openContextMenu, closeContextMenu } from "./ui/ContextMenu.js";
import { bridge } from "./bridge.js";
import { createLatexObject } from "./objects/LatexBox.js";
import { createImageObject } from "./objects/ImageBox.js";
import { createPdfPageObject } from "./objects/PdfPage.js";
import { PdfService } from "./pdf/PdfService.js";
import { createGraphObject, GraphEditor } from "./objects/GraphBox.js";
import { createCodeObject } from "./objects/CodeCell.js";
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
      pen: new PenTool(this, "pen"),
      highlighter: new PenTool(this, "highlighter"),
      eraser_stroke: new EraserTool(this, "stroke"),
      eraser_partial: new EraserTool(this, "partial"),
      ...Object.fromEntries(
        SHAPE_KINDS.map((kind) => [`shape_${kind}`, new ShapeTool(this, kind)])),
    };
    this.tool = null;

    root.querySelector("#ribbon").appendChild(buildRibbon(this));
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
    this.host.addEventListener("scene:reload", () => this.setSelection([]));

    this.languages = {};
    this.loadLanguages();

    this.setTool("pen");
    this._updateStatus();
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

  // ── Selection ─────────────────────────────
  setSelection(ids) {
    this.selection = new Set(ids);
    this.scene.ink.setHighlighted(this.selection);
    this.scene.objects.setHighlighted(this.selection);
    this.selectionController.refresh();
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
    this.history.run(addElements([object], "Insert LaTeX"));
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
      // blown up past its own resolution
      const rect = this.host.getBoundingClientRect();
      const maxWidth = (rect.width * 0.5) / this.scene.scale;
      const scale = Math.min(1, maxWidth / size.width);
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

    this.history.run(addElements(created, created.length > 1 ? "Insert images" : "Insert image"));
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

    this.history.run(addElements(created,
      `Insert ${created.length} PDF page${created.length === 1 ? "" : "s"}`));

    if (placement === "pages" && canvas.pages.length) {
      this.scrollToPage(canvas.pages[canvas.pages.length - pages.length]);
    }
    this.setTool("select");
    this.setSelection([]);
    this._flash(`Inserted ${created.length} page${created.length === 1 ? "" : "s"} from ${fileName}`);
  }

  insertCode(filename = "untitled.py") {
    const rect = this.host.getBoundingClientRect();
    const centre = this.scene.toScene(
      rect.left + rect.width / 2, rect.top + rect.height / 2);
    const object = createCodeObject(
      Math.round(centre.x - 280), Math.round(centre.y - 190), filename);
    this.history.run(addElements([object], "Insert code cell"));
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
    this.history.run(addElements([object], "Insert plot"));
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

  updateObjectPayload(id, payload) {
    const object = this.store.find(id);
    if (!object) return;
    this.history.run(patchElements(
      [{ id, before: { payload: object.payload }, after: { payload } }],
      "Edit LaTeX",
    ));
  }

  // ── Files ─────────────────────────────────
  newDocument() {
    this.assets.clear();
    this.pdf.clear();
    this.store.replaceDocument(createEmptyDocument());
    this.history.clear();
    this.setSelection([]);
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
    if (saved) this._flash(`Saved ${saved}`);
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
    document.querySelector("#status-page").textContent =
      here ? `Page ${here.index + 1} of ${pages.length}` : "";

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
    const previous = el.textContent;
    el.textContent = message;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { el.textContent = previous; }, 2500);
  }
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
