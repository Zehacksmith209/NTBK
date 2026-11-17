import JXG from "jsxgraph";
import { registerObjectType } from "./registry.js";
import { snapshotBoard, queueSnapshot } from "../graph/snapshot.js";
import { typeableReadout } from "../ui/NumberField.js";
import { createObject } from "../model/document.js";
import {
  createGraphSpec, buildBoard, compileExpression, compileSurface, compile2d,
  compile3d, isEquation, parseData, DEFAULT_COLORS, VIEW_PRESETS, applyView3D,
  surfacesOf, zoomBounds, panBounds, zoomOf, DEFAULT_SPAN,
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

    // A plot on the page is a PICTURE of a board, not a board.
    //
    // The board is built live, photographed a moment later, and then freed.
    // What stays on the page is one image. A live board is several hundred
    // SVG nodes plus JSXGraph's own bookkeeping, and a notebook with twenty
    // of them pays for all twenty on every pan and zoom even though none of
    // them is being edited. Editing still happens on a live board, in the
    // plot editor; this one is rebuilt and re-photographed whenever the plot
    // changes.
    //
    // (An earlier version of this comment said a serialised 3D surface
    // vanishes inside an <img>. Measured again with the SVG made standalone
    // first — see snapshot.js — the surface survives.)
    let generation = 0;       // bumped whenever the board's look changes
    let freezeTimer = null;
    let stillUrl = null;      // object URL of the picture on show, if any
    const FREEZE_AFTER = 450; // long enough that typing does not thrash it

    function dropStill() {
      if (stillUrl) { URL.revokeObjectURL(stillUrl); stillUrl = null; }
    }

    function scheduleFreeze(delay = FREEZE_AFTER) {
      clearTimeout(freezeTimer);
      freezeTimer = setTimeout(() => {
        const mine = generation;
        queueSnapshot(async () => {
          // Anything that changed the board since this was asked for makes
          // the photograph stale; a newer request is already on its way.
          if (mine !== generation || !board) return;
          const url = await snapshotBoard(holder, drawnW, drawnH);
          if (!url) return;                      // stays live: slower, never wrong
          const picture = new Image();
          picture.className = "ntbk-graph-still";
          picture.alt = "";
          picture.draggable = false;
          picture.src = url;
          await picture.decode().catch(() => {});
          if (mine !== generation || !board) { URL.revokeObjectURL(url); return; }
          JXG.JSXGraph.freeBoard(board);
          board = null;
          holder.innerHTML = "";
          holder.appendChild(picture);
          dropStill();
          stillUrl = url;
        });
      }, delay);
    }

    // A plot of k*x^2 redraws when k is changed in a Variables box
    const onVariables = () => drawSoon(current);
    window.addEventListener("ntbk:variables", onVariables);

    function draw(next) {
      current = next;
      generation++;
      if (board) { JXG.JSXGraph.freeBoard(board); board = null; }
      holder.innerHTML = "";
      dropStill();
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
      scheduleFreeze();
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

    /**
     * Coalesce a burst of changes into one rebuild.
     *
     * A board is built from scratch every time — there is no incremental
     * update path in JSXGraph — and a plot carrying an awkward function can
     * take over 100ms to build. Typing an expression fires a change per
     * keystroke and dragging a zoom slider fires one per step, so without
     * this the board is rebuilt tens of times during a single gesture and
     * every one of them blocks the main thread.
     *
     * The first change in a burst draws immediately, so nothing feels
     * delayed; the rest are collapsed into one trailing rebuild.
     */
    let pending = null;
    let latest = object;
    let lastDraw = 0;
    const REBUILD_GAP = 140;

    function drawSoon(next) {
      // Held explicitly rather than read back at timer time. `current` does
      // happen to alias the live store object, but this file already carries
      // scars from depending on that, so the newest value is kept here where
      // it is obvious.
      latest = next;
      const since = performance.now() - lastDraw;
      if (pending) clearTimeout(pending);
      if (since >= REBUILD_GAP) {
        lastDraw = performance.now();
        draw(latest);
        return;
      }
      pending = setTimeout(() => {
        pending = null;
        lastDraw = performance.now();
        draw(latest);
      }, REBUILD_GAP - since);
    }

    draw(object);
    lastDraw = performance.now();

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
        else drawSoon(next);
      },
      /**
       * Move the camera without rebuilding the board.
       *
       * Rebuilding a 3D board costs ~113ms, so a slider drag that rebuilt per
       * frame would judder. The inspector drives this while you drag and
       * writes the view into the document only when you let go.
       */
      applyView(view) {
        // The camera can only be moved on a real board, so a plot that has
        // been turned into a picture is brought back to life first, and is
        // photographed again once the dragging stops.
        if (!board) draw(current);
        generation++;
        applyView3D(board?.ntbkView3D, view);
        scheduleFreeze(700);
      },
      destroy() {
        window.removeEventListener("ntbk:variables", onVariables);
        clearTimeout(freezeTimer);
        if (pending) clearTimeout(pending);
        generation++;
        if (board) { JXG.JSXGraph.freeBoard(board); board = null; }
        dropStill();
      },
    };
  },
});

// ─────────────────────────────────────────────
//  EDITOR
//  A live board you can pan, zoom and edit, then
//  close to commit what you see.
// ─────────────────────────────────────────────
/**
 * The "y = …" rows: colour swatch, expression, remove.
 *
 * Shared by the floating plot editor and the inspector's Editor tab, so there
 * is one definition of what a function row is and they cannot drift apart.
 * The caller owns the data; this only reports what you did to it.
 */
export function buildExpressionRows(container, items, options) {
  // A surface is a function of x AND y, so validating one with the
  // single-variable compiler rejects every valid expression it has.
  const { prefix = "y =", validate = compile2d, onEdit, onRemove } = options;
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "ntbk-ge-row";
    row.innerHTML = `
      <span class="ntbk-ge-swatch" style="background:${item.color}"></span>
      <span class="ntbk-ge-y">${prefix}</span>
      <input type="text" value="${item.expr.replace(/"/g, "&quot;")}" spellcheck="false">
      <button class="ntbk-ge-del" title="Remove">✕</button>`;

    const input = row.querySelector("input");
    const label = row.querySelector(".ntbk-ge-y");
    // "y =" is a lie once you type a whole equation, so it steps aside
    const showLabel = () => {
      label.textContent = isEquation(input.value) ? "" : prefix;
      label.classList.toggle("is-empty", isEquation(input.value));
    };
    showLabel();
    input.addEventListener("input", () => {
      showLabel();
      // Bad syntax colours the row but is never pushed at the plotter, so a
      // half-typed expression doesn't blank the graph under you
      const ok = validate(input.value) !== null;
      row.classList.toggle("is-bad", !ok && input.value.trim() !== "");
      onEdit(index, input.value, ok, input);
    });
    input.addEventListener("keydown", (event) => event.stopPropagation());
    row.querySelector(".ntbk-ge-del").addEventListener("click", () => onRemove(index));
    container.appendChild(row);
  });
}

/**
 * Iso / Top / Bottom / Front / Side. Shared by the plot editor and the
 * inspector so the two always offer the same set.
 */
export function buildViewPresets(container, onPick) {
  for (const [label, key] of [
    ["Iso", "isometric"], ["Top", "top"], ["Bottom", "bottom"],
    ["Front", "front"], ["Side", "side"],
  ]) {
    const button = document.createElement("button");
    button.className = "ntbk-mini";
    button.textContent = label;
    button.addEventListener("click", () => onPick(key));
    container.appendChild(button);
  }
}

/**
 * Turn / Tilt / Roll — named for what they show you, not the axis they turn
 * about. `onMove` fires continuously while dragging, `onSettle` once at the
 * end, which is what keeps one drag to one undo entry.
 */
export function buildViewSliders(container, view, { onMove, onSettle }) {
  const handles = {};
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
             value="${view?.[key] ?? 0}">
      <output></output>`;
    const range = slider.querySelector("input");
    range.addEventListener("input", () => onMove(key, Number(range.value)));
    range.addEventListener("change", () => onSettle?.(key, Number(range.value)));
    // Stored in radians, read and typed in degrees — nobody thinks in radians
    const field = typeableReadout(range, slider.querySelector("output"), {
      toDisplay: (radians) => (radians * 180) / Math.PI,
      fromDisplay: (degrees) => (degrees * Math.PI) / 180,
      unit: "\u00b0",
      decimals: 0,
    });
    handles[key] = { range, show: field.show };
    container.appendChild(slider);
  }
  return handles;
}

/**
 * Move around the plotted region: a zoom slider and a pad of nudges.
 *
 * Both act on the ranges, so they mean the same thing in 2D and 3D and are
 * saved with the document. `depth` adds the up/down pair a 3D plot needs for
 * moving through z.
 */
export function buildViewControls(container, { zoom, onZoom, onPan, depth = false }) {
  const zoomRow = document.createElement("div");
  zoomRow.className = "ntbk-ge-slider";
  zoomRow.innerHTML = `
    <label title="How much of the region you are looking at">Zoom</label>
    <input type="range" min="0.1" max="10" step="0.05" value="${zoom}">
    <output></output>`;
  const range = zoomRow.querySelector("input");
  range.addEventListener("input", () => onZoom(Number(range.value), false));
  range.addEventListener("change", () => onZoom(Number(range.value), true));
  container.appendChild(zoomRow);
  // Typeable, like every other number beside a slider
  const field = typeableReadout(range, zoomRow.querySelector("output"), {
    unit: "\u00d7", decimals: 2,
  });

  const padRow = document.createElement("div");
  padRow.className = "ntbk-ge-pan";
  const nudge = (label, title, dx, dy, dz) => {
    const button = document.createElement("button");
    button.className = "ntbk-mini";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", () => onPan(dx, dy, dz));
    padRow.appendChild(button);
    return button;
  };
  nudge("\u25c0", "Move left", -0.15, 0, 0);
  nudge("\u25b6", "Move right", 0.15, 0, 0);
  nudge("\u25b2", "Move up", 0, 0.15, 0);
  nudge("\u25bc", "Move down", 0, -0.15, 0);
  if (depth) {
    nudge("\u2191z", "Up through z", 0, 0, 0.15);
    nudge("\u2193z", "Down through z", 0, 0, -0.15);
  }
  const home = nudge("\u2302", "Back to the middle", 0, 0, 0);
  home.dataset.home = "1";
  home.addEventListener("click", () => onPan(0, 0, 0, true));
  container.appendChild(padRow);

  return { zoomField: field, zoomRange: range };
}

/** Chart type and data — the statistics plot's whole control set. */
export function buildStatsControls(container, spec, { onChart, onData }) {
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
  select.value = spec.chartType;
  select.addEventListener("change", () => onChart(select.value));
  container.appendChild(typeRow);

  const dataRow = document.createElement("div");
  dataRow.className = "ntbk-ge-data";
  dataRow.innerHTML = `
    <label>Data</label>
    <textarea spellcheck="false" rows="3">${spec.data.join(", ")}</textarea>`;
  const area = dataRow.querySelector("textarea");
  area.addEventListener("keydown", (event) => event.stopPropagation());
  area.addEventListener("input", () => {
    const values = parseData(area.value);
    if (values.length) onData(values);
  });
  container.appendChild(dataRow);
}

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
    if (this.spec.kind === "surface3d") {
      this.renderSurfaceControls();
      return this.renderViewControls();
    }
    if (this.spec.kind === "stats") return this.renderStatsControls();

    buildExpressionRows(this.list, this.spec.functions, {
      onEdit: (index, value, ok) => {
        this.spec.functions[index].expr = value;
        if (ok) this.rebuild();
      },
      onRemove: (index) => {
        this.spec.functions.splice(index, 1);
        this.renderList();
        this.rebuild();
        this.place();
      },
    });
    this.renderViewControls();
  }

  /** Zoom and pan, the same control the inspector shows. */
  renderViewControls() {
    const is2d = !!this.spec.bounds;
    const span = is2d
      ? this.spec.bounds[2] - this.spec.bounds[0]
      : this.spec.xRange[1] - this.spec.xRange[0];

    buildViewControls(this.list, {
      zoom: zoomOf(span, is2d ? DEFAULT_SPAN.x2d : DEFAULT_SPAN.x3d),
      depth: !is2d,
      onZoom: (value) => {
        const reference = is2d ? DEFAULT_SPAN.x2d : DEFAULT_SPAN.x3d;
        const now = is2d
          ? this.spec.bounds[2] - this.spec.bounds[0]
          : this.spec.xRange[1] - this.spec.xRange[0];
        const factor = value / zoomOf(now, reference);
        if (is2d) {
          this.spec.bounds = zoomBounds(this.spec.bounds, factor);
        } else {
          for (const key of ["xRange", "yRange", "zRange"]) {
            const [min, max] = this.spec[key];
            const centre = (min + max) / 2;
            const half = ((max - min) / 2) / factor;
            this.spec[key] = [centre - half, centre + half];
          }
        }
        this.rebuild();
      },
      onPan: (dx, dy, dz, home = false) => {
        const recentre = ([min, max]) => {
          const half = (max - min) / 2;
          return [-half, half];
        };
        const shift = ([min, max], fraction) => {
          const step = (max - min) * fraction;
          return [min + step, max + step];
        };
        if (home) {
          if (is2d) {
            const hx = (this.spec.bounds[2] - this.spec.bounds[0]) / 2;
            const hy = (this.spec.bounds[1] - this.spec.bounds[3]) / 2;
            this.spec.bounds = [-hx, hy, hx, -hy];
          } else {
            for (const key of ["xRange", "yRange", "zRange"]) {
              this.spec[key] = recentre(this.spec[key]);
            }
          }
        } else if (is2d) {
          this.spec.bounds = panBounds(this.spec.bounds, dx, -dy);
        } else {
          this.spec.xRange = shift(this.spec.xRange, dx);
          this.spec.yRange = shift(this.spec.yRange, dy);
          this.spec.zRange = shift(this.spec.zRange, dz);
        }
        this.rebuild();
        this.renderList();
        this.place();
      },
    });
  }

  renderSurfaceControls() {
    // Normalise once, so older single-expression documents edit like new ones
    this.spec.surfaces = surfacesOf(this.spec);
    delete this.spec.expr;
    delete this.spec.color;

    buildExpressionRows(this.list, this.spec.surfaces, {
      prefix: "z =",
      validate: compile3d,
      onEdit: (index, value, ok) => {
        this.spec.surfaces[index].expr = value;
        if (ok) this.rebuild();
      },
      onRemove: (index) => {
        this.spec.surfaces.splice(index, 1);
        this.renderList();
        this.rebuild();
        this.place();
      },
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
    buildViewPresets(presets, (key) => {
      this.spec.view = { ...VIEW_PRESETS[key] };
      this.applyView();
      this.syncViewSliders();
    });
    this.list.appendChild(presets);

    // ── Turn / Tilt / Roll ──
    // Named for what they show you, not for the axis they turn about
    this.viewSliders = buildViewSliders(this.list, this.spec.view, {
      onMove: (key, value) => {
        this.spec.view = { ...this.spec.view, [key]: value };
        this.applyView();     // moves the camera without rebuilding the board
      },
    });
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
    buildStatsControls(this.list, this.spec, {
      onChart: (value) => { this.spec.chartType = value; this.rebuild(); },
      onData: (values) => { this.spec.data = values; this.rebuild(); },
    });
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
