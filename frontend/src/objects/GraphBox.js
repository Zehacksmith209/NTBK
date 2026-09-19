import JXG from "jsxgraph";
import { registerObjectType } from "./registry.js";
import { createObject } from "../model/document.js";
import {
  createGraphSpec, buildBoard, compileExpression, compileSurface,
  parseData, DEFAULT_COLORS, VIEW_PRESETS, applyView3D, surfacesOf,
} from "../graph/GraphRenderer.js";

// ─────────────────────────────────────────────
//  GRAPH
//
//  Rendered on the canvas, interactive in an
//  editor. A live pan/zoom board sitting inside
//  a pan/zoom canvas makes every gesture
//  ambiguous — does a scroll zoom the plot or
//  the page? Editing in a panel gives full
//  interaction with no ambiguity, and what
//  lands on the page is a plot you can annotate
//  like anything else.
// ─────────────────────────────────────────────
export function createGraphObject(x, y, kind = "function2d") {
  const square = kind === "surface3d";     // a 3D box wants even proportions
  return createObject({
    type: "graph",
    x, y,
    w: square ? 380 : 420,
    h: square ? 380 : 315,
    payload: createGraphSpec(kind),
  });
}

registerObjectType("graph", {
  mount(el, object, context) {
    el.classList.add("ntbk-graph");

    const holder = document.createElement("div");
    holder.className = "ntbk-graph-board";
    el.appendChild(holder);

    // An explicit way back into the editor. Double-click still works, but it
    // has to travel through the canvas's own pointer handling and the tool
    // that happens to be active; a real button never does.
    const edit = document.createElement("button");
    edit.className = "ntbk-graph-edit";
    edit.textContent = "Edit";
    edit.title = "Edit this plot";
    edit.addEventListener("pointerdown", (event) => event.stopPropagation());
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      context.editGraph(current.id);
    });
    el.appendChild(edit);

    let current = object;
    let board = null;
    // The size the board was actually drawn at. While a resize handle is
    // being dragged we stretch that drawing instead of rebuilding it.
    let drawnW = object.w;
    let drawnH = object.h;
    // A signature, not the object. `current` holds a reference to the live
    // store object, so comparing next.payload against current.payload is
    // comparing it with itself — always equal, never redraws.
    let signature = null;
    const signatureOf = (o) => JSON.stringify([o.w, o.h, o.payload]);

    // The board is mounted live rather than serialised to an image.
    //
    // Serialising JSXGraph's SVG and showing it through an <img> silently
    // drops 3D surfaces: the mesh depends on gradients, clip paths and
    // visibility that an <img>-loaded SVG cannot resolve, so the axes
    // survive and the surface vanishes.
    //
    // Live is also simpler and sharper — it re-renders at whatever size you
    // resize to. The reason we avoided live boards was gesture ownership,
    // and pointer-events:none settles that: this board is inert, and the
    // editor is still the only place a plot is interactive.
    function draw(next) {
      current = next;
      if (board) { JXG.JSXGraph.freeBoard(board); board = null; }
      holder.innerHTML = "";
      holder.style.width = `${Math.round(next.w)}px`;
      holder.style.height = `${Math.round(next.h)}px`;
      try {
        board = buildBoard(holder, next.payload, { interactive: false });
      } catch {
        holder.textContent = "Could not draw this plot";
      }
      signature = signatureOf(next);
      drawnW = next.w;
      drawnH = next.h;
      holder.style.transform = "none";
    }

    /**
     * Cheap stand-in during a drag: scale the SVG we already have.
     *
     * Rebuilding a 3D board costs about 113ms — roughly seven frames at
     * 60fps — so doing it per pointermove made resizing visibly judder.
     * A transform costs nothing, and SelectionController calls back once
     * the drag ends so the plot is redrawn properly at its new size.
     */
    function stretch(next) {
      holder.style.transformOrigin = "0 0";
      holder.style.transform = `scale(${next.w / drawnW}, ${next.h / drawnH})`;
    }

    draw(object);

    el.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      context.editGraph(current.id);
    });
    el.addEventListener("ntbk:edit", () => context.editGraph(current.id));

    return {
      update(next) {
        // Redraw only when something affecting the drawing changed —
        // a plain move shouldn't rebuild the board
        const nextSignature = signatureOf(next);
        // Against the DRAWN size, not against `current` — `current` holds a
        // reference to the same live store object as `next`, so comparing
        // the two is comparing it with itself and never differs.
        const resizedOnly = next.w !== drawnW || next.h !== drawnH;
        current = next;
        if (nextSignature === signature) return;

        if (resizedOnly && context.isTransforming?.()) stretch(next);
        else draw(next);
      },
      destroy() { if (board) JXG.JSXGraph.freeBoard(board); },
    };
  },
});

// ─────────────────────────────────────────────
//  EDITOR
//  A live board you can pan, zoom and edit, then
//  close to commit what you see.
// ─────────────────────────────────────────────
export class GraphEditor {
  constructor(app, object) {
    this.app = app;
    this.objectId = object.id;
    this.spec = JSON.parse(JSON.stringify(object.payload));
    this.board = null;

    const title = { surface3d: "3D surface", stats: "Statistics" }[object.payload.kind]
      ?? "Plot";
    const el = document.createElement("div");
    el.className = "ntbk-graph-editor";
    el.innerHTML = `
      <div class="ntbk-ge-head">
        <strong>${title}</strong>
        <span class="ntbk-ge-hint">${object.payload.kind === "surface3d"
          ? "drag to rotate" : "drag to pan · scroll to zoom"}</span>
        <button class="ntbk-ge-close" title="Done">Done</button>
      </div>
      <div class="ntbk-ge-board"></div>
      <div class="ntbk-ge-list"></div>
      <div class="ntbk-ge-foot">
        <button class="ntbk-mini" data-add>+ Add function</button>
        <button class="ntbk-mini" data-reset>Reset view</button>
      </div>`;
    // "Add function" and "Reset view" are 2D-only controls
    if (object.payload.kind && object.payload.kind !== "function2d") {
      el.querySelector(".ntbk-ge-foot").remove();
    }
    this.el = el;
    app.host.appendChild(el);

    // The canvas must not see any of this as drawing or selection
    for (const type of ["pointerdown", "pointermove", "pointerup", "wheel", "dblclick"]) {
      el.addEventListener(type, (event) => event.stopPropagation());
    }

    this.boardHolder = el.querySelector(".ntbk-ge-board");
    this.list = el.querySelector(".ntbk-ge-list");

    el.querySelector(".ntbk-ge-close").addEventListener("click", () => this.close());
    el.querySelector("[data-add]")?.addEventListener("click", () => this.addFunction());
    el.querySelector("[data-reset]")?.addEventListener("click", () => {
      this.spec.bounds = [-8, 6, 8, -6];
      this.rebuild();
    });

    this.rebuild();
    this.renderList();
    this.place();
  }

  place() {
    const object = this.app.store.find(this.objectId);
    if (!object) return;
    const sceneRect = this.app.scene.sceneEl.getBoundingClientRect();
    const hostRect = this.app.host.getBoundingClientRect();
    const scale = this.app.scene.scale;
    let x = sceneRect.left - hostRect.left + object.x * scale;
    let y = sceneRect.top - hostRect.top + (object.y + object.h) * scale + 10;

    // Measure the panel rather than assuming a height — it grows with every
    // function you add, and a guessed height runs off the bottom of the window
    const bounds = this.app.host.getBoundingClientRect();
    const panelWidth = this.el.offsetWidth || 372;
    const panelHeight = this.el.offsetHeight || 420;
    x = Math.max(6, Math.min(x, bounds.width - panelWidth - 6));
    y = Math.max(6, Math.min(y, bounds.height - panelHeight - 6));
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
  }

  rebuild() {
    if (this.board) JXG.JSXGraph.freeBoard(this.board);
    this.boardHolder.innerHTML = "";
    this.board = buildBoard(this.boardHolder, this.spec, { interactive: true });
    // Panning or zooming the board is how you choose the plotted range
    if (this.spec.kind === "function2d" || !this.spec.kind) {
      this.board.on("boundingbox", () => {
        this.spec.bounds = this.board.getBoundingBox();
      });
    }
  }

  renderList() {
    this.list.innerHTML = "";
    if (this.spec.kind === "surface3d") return this.renderSurfaceControls();
    if (this.spec.kind === "stats") return this.renderStatsControls();

    this.spec.functions.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "ntbk-ge-row";
      row.innerHTML = `
        <span class="ntbk-ge-swatch" style="background:${item.color}"></span>
        <span class="ntbk-ge-y">y =</span>
        <input type="text" value="${item.expr.replace(/"/g, "&quot;")}" spellcheck="false">
        <button class="ntbk-ge-del" title="Remove">✕</button>`;

      const input = row.querySelector("input");
      input.addEventListener("input", () => {
        item.expr = input.value;
        const ok = compileExpression(item.expr) !== null;
        row.classList.toggle("is-bad", !ok && item.expr.trim() !== "");
        if (ok) this.rebuild();
      });
      row.querySelector(".ntbk-ge-del").addEventListener("click", () => {
        this.spec.functions.splice(index, 1);
        this.renderList();
        this.rebuild();
        this.place();
      });
      this.list.appendChild(row);
    });
  }

  renderSurfaceControls() {
    // Normalise once, so older single-expression documents edit like new ones
    this.spec.surfaces = surfacesOf(this.spec);
    delete this.spec.expr;
    delete this.spec.color;

    this.spec.surfaces.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "ntbk-ge-row";
      row.innerHTML = `
        <span class="ntbk-ge-swatch" style="background:${item.color}"></span>
        <span class="ntbk-ge-y">z =</span>
        <input type="text" value="${item.expr.replace(/"/g, "&quot;")}" spellcheck="false">
        <button class="ntbk-ge-del" title="Remove">✕</button>`;
      const input = row.querySelector("input");
      input.addEventListener("input", () => {
        item.expr = input.value;
        const ok = compileSurface(item.expr) !== null;
        row.classList.toggle("is-bad", !ok && item.expr.trim() !== "");
        if (ok) this.rebuild();
      });
      row.querySelector(".ntbk-ge-del").addEventListener("click", () => {
        this.spec.surfaces.splice(index, 1);
        this.renderList();
        this.rebuild();
        this.place();
      });
      this.list.appendChild(row);
    });

    const add = document.createElement("button");
    add.className = "ntbk-mini";
    add.style.width = "100%";
    add.style.marginBottom = "8px";
    add.textContent = "+ Add surface";
    add.addEventListener("click", () => {
      const color = DEFAULT_COLORS[this.spec.surfaces.length % DEFAULT_COLORS.length];
      this.spec.surfaces.push({ expr: "x*y/4", color });
      this.renderList();
      this.rebuild();
      this.place();
      const inputs = this.list.querySelectorAll('input[type="text"]');
      inputs[inputs.length - 1]?.select();
    });
    this.list.appendChild(add);

    // ── Preset views ──
    const presets = document.createElement("div");
    presets.className = "ntbk-ge-presets";
    for (const [label, key] of [
      ["Iso", "isometric"], ["Top", "top"], ["Bottom", "bottom"],
      ["Front", "front"], ["Side", "side"],
    ]) {
      const button = document.createElement("button");
      button.className = "ntbk-mini";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.spec.view = { ...VIEW_PRESETS[key] };
        this.applyView();
        this.syncViewSliders();
      });
      presets.appendChild(button);
    }
    this.list.appendChild(presets);

    // ── Turn / Tilt / Roll ──
    // Named for what they show you, not for the axis they turn about
    this.viewSliders = {};
    for (const [key, label, min, max, hint] of [
      ["az", "Turn", 0, Math.PI * 2, "around the sides"],
      ["el", "Tilt", -Math.PI / 2, Math.PI / 2, "top and bottom"],
      ["bank", "Roll", -Math.PI, Math.PI, "spin in frame"],
    ]) {
      const slider = document.createElement("div");
      slider.className = "ntbk-ge-slider";
      slider.innerHTML = `
        <label title="${hint}">${label}</label>
        <input type="range" min="${min}" max="${max}" step="0.01"
               value="${this.spec.view?.[key] ?? 0}">
        <output></output>`;
      const range = slider.querySelector("input");
      const out = slider.querySelector("output");
      const show = () => { out.textContent = `${Math.round(range.value * 180 / Math.PI)}°`; };
      show();
      range.addEventListener("input", () => {
        this.spec.view = { ...this.spec.view, [key]: Number(range.value) };
        show();
        this.applyView();     // moves the camera without rebuilding the board
      });
      this.viewSliders[key] = { range, show };
      this.list.appendChild(slider);
    }
  }

  /** Move the camera on the live board. Cheap — no rebuild. */
  applyView() {
    applyView3D(this.board?.ntbkView3D, this.spec.view);
  }

  syncViewSliders() {
    for (const [key, slider] of Object.entries(this.viewSliders ?? {})) {
      slider.range.value = this.spec.view?.[key] ?? 0;
      slider.show();
    }
  }

  renderStatsControls() {
    const typeRow = document.createElement("div");
    typeRow.className = "ntbk-ge-row";
    typeRow.innerHTML = `
      <span class="ntbk-ge-y">Chart</span>
      <select class="ntbk-ge-select">
        <option value="bar">Bar</option>
        <option value="line">Line</option>
        <option value="boxplot">Box plot</option>
      </select>`;
    const select = typeRow.querySelector("select");
    select.value = this.spec.chartType;
    select.addEventListener("change", () => {
      this.spec.chartType = select.value;
      this.rebuild();
    });
    this.list.appendChild(typeRow);

    const dataRow = document.createElement("div");
    dataRow.className = "ntbk-ge-data";
    dataRow.innerHTML = `
      <label>Data</label>
      <textarea spellcheck="false" rows="3">${this.spec.data.join(", ")}</textarea>`;
    const area = dataRow.querySelector("textarea");
    area.addEventListener("input", () => {
      const values = parseData(area.value);
      if (values.length) { this.spec.data = values; this.rebuild(); }
    });
    this.list.appendChild(dataRow);
  }

  addFunction() {
    const color = DEFAULT_COLORS[this.spec.functions.length % DEFAULT_COLORS.length];
    this.spec.functions.push({ expr: "sin(x)", color });
    this.renderList();
    this.rebuild();
    this.place();                 // the panel just got taller
    const inputs = this.list.querySelectorAll("input");
    inputs[inputs.length - 1]?.focus();
    inputs[inputs.length - 1]?.select();
  }

  close() {
    const object = this.app.store.find(this.objectId);
    if (object) {
      const before = object.payload;
      const after = JSON.parse(JSON.stringify(this.spec));
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        this.app.updateObjectPayload(this.objectId, after);
      }
    }
    this.destroy();
  }

  destroy() {
    if (this.board) JXG.JSXGraph.freeBoard(this.board);
    this.board = null;
    this.el.remove();
    if (this.app.graphEditor === this) this.app.graphEditor = null;
  }
}
