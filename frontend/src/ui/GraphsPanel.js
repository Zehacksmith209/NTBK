import { SimGraph, Hover, graphColour } from "../sim/graphs.js";
import { plotsOf, graphName, quantitySelect } from "../objects/SimBox.js";

// ─────────────────────────────────────────────
//  GRAPHS PANEL
//
//  A panel on the right of the canvas for
//  looking at simulations' graphs closely: tall,
//  stacked, with room for as many as you want.
//
//  It holds any number of simulations at once.
//  Each has its own section, headed with the
//  simulation's name and a colour tag; the same
//  colour marks that simulation's box on the
//  canvas, so which graph belongs to which is
//  never in doubt.
//
//  The panel shows copies. The graphs under each
//  simulation stay where they are, and the panel
//  chooses its own: adding a graph here does not
//  crowd the box.
//
//  What is in the panel is how you are looking
//  at the notebook, not part of it: it is not
//  saved and not undone.
// ─────────────────────────────────────────────

const TAGS = ["#1a6ef5", "#2f9e6e", "#d9822b", "#8c5ba8", "#d0483a", "#0e9aa7", "#b5487e", "#6b7a12"];
const sameGraph = (a, b) => a.x === b.x && a.y === b.y;

export class GraphsPanel {
  constructor(app) {
    this.app = app;
    this.sections = new Map();    // simulation id → PanelSection
    this.root = null;
    // A simulation deleted, renamed, rebuilt, or a notebook tab switched
    app.store.subscribe(() => queueMicrotask(() => this.sync()));
  }

  has(id) { return this.sections.has(id); }
  colourOf(id) { return this.sections.get(id)?.tag ?? null; }
  get open() { return !!this.root; }

  toggle(id) { if (this.has(id)) this.remove(id); else this.add(id); }

  /** Put a simulation's graphs in the panel (opening it), or go to them if they are already there. */
  add(id, { graphs = null, tag = null } = {}) {
    if (this.has(id)) { this.sections.get(id).reveal(); return; }
    const handle = this.app.objectHandle(id);
    if (!handle?.scenario) return;
    this.show();
    const used = new Set([...this.sections.values()].map((s) => s.tag));
    const colour = tag ?? TAGS.find((c) => !used.has(c)) ?? TAGS[this.sections.size % TAGS.length];
    const section = new PanelSection(this, id, handle, colour, graphs);
    this.sections.set(id, section);
    this.body.appendChild(section.root);
    section.build();
    section.reveal();
    handle.refreshGraphBar();
    this.changed();
  }

  remove(id) {
    const section = this.sections.get(id);
    if (!section) return;
    section.destroy();
    this.sections.delete(id);
    this.app.objectHandle(id)?.refreshGraphBar?.();
    if (!this.sections.size) this.hide();
    else this.changed();
  }

  /** Close the panel: every section out of it. */
  closeAll() {
    for (const id of [...this.sections.keys()]) this.remove(id);
    this.hide();
  }

  /** Keep up with the notebook: drop simulations that are gone, follow ones that were remounted. */
  sync() {
    for (const [id, section] of [...this.sections]) {
      const object = this.app.store.find(id);
      const handle = object ? this.app.objectHandle(id) : null;
      if (!object || !handle?.scenario) { this.remove(id); continue; }
      if (handle !== section.handle) {
        // Mounted afresh (moved between layers, say): same graphs, same colour
        const { graphs, tag } = section;
        this.remove(id);
        this.add(id, { graphs, tag });
        continue;
      }
      section.rename();
    }
  }

  // ── The panel itself ──
  show() {
    if (this.root) return;
    const root = document.createElement("div");
    root.className = "ntbk-fullgraph ntbk-sim-dock ntbk-graphs-panel";
    root.style.flexBasis = `${this.width()}px`;
    root.innerHTML = `
      <div class="ntbk-fullgraph-bar">
        <strong>Graphs</strong>
        <span class="ntbk-gp-count"></span>
        <button class="ntbk-ge-close" data-close title="Close the graphs panel">×</button>
      </div>
      <div class="ntbk-sim-dock-body"></div>`;
    root.querySelector("[data-close]").addEventListener("click", () => this.closeAll());
    // Typing in an axis menu is not a canvas shortcut
    root.addEventListener("keydown", (event) => event.stopPropagation());

    const grip = document.createElement("div");
    grip.className = "ntbk-fullgraph-grip";
    grip.title = "Drag to make the graphs wider or narrower";
    root.appendChild(grip);
    let start = null;
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      start = { x: event.clientX, w: root.getBoundingClientRect().width };
    });
    grip.addEventListener("pointermove", (event) => {
      if (start) root.style.flexBasis = `${this.width(start.w + (start.x - event.clientX))}px`;
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.width(root.getBoundingClientRect().width);
      for (const section of this.sections.values()) section.build();
      window.dispatchEvent(new Event("resize"));
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);

    this.root = root;
    this.body = root.querySelector(".ntbk-sim-dock-body");
    this.count = root.querySelector(".ntbk-gp-count");
    (document.querySelector("#canvas-area") ?? document.body).appendChild(root);
    window.dispatchEvent(new Event("resize"));      // the canvas is narrower now
  }

  hide() {
    if (!this.root) return;
    this.root.remove();
    this.root = null;
    window.dispatchEvent(new Event("resize"));
    this.changed();
  }

  /** The panel's width, remembered between sessions. With a value, sets it. */
  width(value) {
    const clamp = (w) => Math.max(280, Math.min(Math.round(window.innerWidth * 0.6), w));
    if (value != null) {
      try { localStorage.setItem("ntbk-graphs-panel-width", String(clamp(value))); } catch { /* fine */ }
      return clamp(value);
    }
    let saved = 420;
    try { saved = Number(localStorage.getItem("ntbk-graphs-panel-width")) || 420; } catch { /* fine */ }
    return clamp(saved);
  }

  changed() {
    if (this.count) {
      const n = this.sections.size;
      this.count.textContent = `${n} simulation${n === 1 ? "" : "s"}`;
    }
    this.app.simBar?.render();
  }
}

/** One simulation's graphs in the panel, under its name. */
class PanelSection {
  constructor(panel, id, handle, tag, graphs) {
    this.panel = panel;
    this.app = panel.app;
    this.id = id;
    this.handle = handle;
    this.tag = tag;
    this.plots = [];
    this.hover = new Hover();
    // The panel's own choice of graphs: to begin with, what the box shows
    this.graphs = (graphs ?? plotsOf(handle.payload, handle.scenario)).map((g) => ({ x: g.x, y: g.y }));
    this.scenario = handle.scenario;
    this.ghost = handle.ghost;

    this.root = document.createElement("section");
    this.root.className = "ntbk-gp-section";
    this.root.style.setProperty("--tag", tag);
    this.root.innerHTML = `
      <div class="ntbk-gp-head">
        <i class="ntbk-sim-tag"></i>
        <span class="ntbk-gp-name"></span>
        <span class="ntbk-gp-kind"></span>
        <button class="ntbk-mini" data-goto title="Show this simulation on the canvas">Go to</button>
        <button class="ntbk-gp-remove" data-remove title="Take this simulation's graphs out of the panel">×</button>
      </div>
      <div class="ntbk-sim-graphbar"></div>
      <div class="ntbk-gp-plots"></div>`;
    this.root.querySelector(".ntbk-sim-tag").style.background = tag;
    this.nameEl = this.root.querySelector(".ntbk-gp-name");
    this.kindEl = this.root.querySelector(".ntbk-gp-kind");
    this.chips = this.root.querySelector(".ntbk-sim-graphbar");
    this.plotsHost = this.root.querySelector(".ntbk-gp-plots");
    this.root.querySelector("[data-goto]").addEventListener("click", () => {
      this.app.selectFromPanel([id], false);
      this.app.goToElement([id]);
    });
    this.root.querySelector("[data-remove]").addEventListener("click", () => panel.remove(id));
    const head = this.root.querySelector(".ntbk-gp-head");
    head.addEventListener("pointerenter", () => this.app.highlightElement([id]));
    head.addEventListener("pointerleave", () => this.app.highlightElement(null));
    this.rename();

    // Every frame: draw. Every change: maybe rebuild.
    this.offFrame = handle.onFrame(() => this.frame());
    this.offChange = handle.subscribe(() => this.changed());
  }

  rename() {
    const object = this.app.store.find(this.id);
    if (!object) return;
    this.nameEl.textContent = object.name ?? this.app.autoName(object);
    this.kindEl.textContent = this.handle.scenario?.title ?? "";
  }

  /** The simulation changed: new equations, a comparison started or stopped. */
  changed() {
    const scenario = this.handle.scenario;
    if (!scenario) return;
    if (scenario !== this.scenario || this.handle.ghost !== this.ghost) {
      this.scenario = scenario;
      this.ghost = this.handle.ghost;
      // Keep the graphs that still mean something; if none do, the model's own
      const valid = plotsOf({ plots: this.graphs }, scenario);
      this.graphs = valid.length ? valid : (scenario.plots ?? []).map((g) => ({ x: g.x, y: g.y }));
      this.rename();
      this.build();
    }
  }

  setGraphs(next) {
    this.graphs = next.map((g) => ({ x: g.x, y: g.y }));
    this.build();
  }

  build() {
    for (const plot of this.plots) plot.destroy();
    this.plots = [];
    this.plotsHost.innerHTML = "";
    const scenario = this.handle.scenario;
    if (!scenario) return;
    this.showChips(scenario);

    const width = Math.max(200, this.plotsHost.clientWidth || this.panel.width() - 2);
    this.graphs.forEach((graph, index) => {
      const isTime = graph.x === "t";
      const plot = new SimGraph({
        graph, colour: graphColour(scenario, graph, index), width,
        height: isTime ? 180 : Math.round(Math.min(340, Math.max(200, width * 0.75))),
        // The same key as the box: point at a time here and the box's graphs point there too
        syncKey: `sim-${this.id}`, hover: this.hover, compare: !!this.handle.ghost,
      });
      this.axisControls(plot.controls, scenario, graph, index);
      if (this.handle.ghost) {
        const note = document.createElement("span");
        note.className = "ntbk-sim-ghostnote";
        note.textContent = `dashed: ${this.handle.payload?.compare ?? ""}`;
        plot.controls.appendChild(note);
      }
      this.plotsHost.appendChild(plot.holder);
      this.plots.push(plot);
    });
    if (!this.graphs.length) {
      const empty = document.createElement("div");
      empty.className = "ntbk-gp-empty";
      empty.textContent = "No graphs. Pick one above, or + Graph.";
      this.plotsHost.appendChild(empty);
    }
    this.frame();
  }

  frame() {
    const run = this.handle.run;
    if (!run) return;
    const span = this.handle.settings?.window ?? 10;
    for (const plot of this.plots) plot.update(run, this.handle.ghost, span);
  }

  /** One-click graphs, the same choices as on the box, but for the panel. */
  showChips(scenario) {
    this.chips.innerHTML = "";
    const quick = scenario.graphs ?? Object.keys(scenario.outputs).map((y) => ({ x: "t", y }));
    for (const graph of quick) {
      const on = this.graphs.some((g) => sameGraph(g, graph));
      const chip = document.createElement("button");
      chip.className = "ntbk-sim-chip";
      chip.classList.toggle("is-on", on);
      chip.textContent = graphName(graph, scenario);
      chip.title = on ? "Click to hide in the panel" : "Click to show in the panel";
      chip.addEventListener("click", () => this.setGraphs(on
        ? this.graphs.filter((g) => !sameGraph(g, graph))
        : [...this.graphs, graph]));
      this.chips.appendChild(chip);
    }
    const add = document.createElement("button");
    add.className = "ntbk-sim-chip is-add";
    add.textContent = "+ Graph";
    add.title = "Add a graph, then pick what goes on each axis";
    add.addEventListener("click", () => {
      const keys = Object.keys(scenario.outputs);
      const y = keys.find((k) => !this.graphs.some((g) => g.x === "t" && g.y === k)) ?? keys[0];
      this.setGraphs([...this.graphs, { x: "t", y }]);
      this.plots.at(-1)?.holder.scrollIntoView({ block: "nearest" });
    });
    this.chips.appendChild(add);
  }

  /** "[y] against [x] ×" over a graph's corner. */
  axisControls(host, scenario, graph, index) {
    const y = quantitySelect(scenario, graph.y, "Up the side");
    const x = quantitySelect(scenario, graph.x, "Along the bottom");
    const against = document.createElement("span");
    against.textContent = "against";
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Remove this graph from the panel";
    const change = (patch) => this.setGraphs(this.graphs.map((g, i) => (i === index ? { ...g, ...patch } : g)));
    y.addEventListener("change", () => change({ y: y.value }));
    x.addEventListener("change", () => change({ x: x.value }));
    remove.addEventListener("click", () => this.setGraphs(this.graphs.filter((_, i) => i !== index)));
    host.append(y, against, x, remove);
  }

  reveal() {
    this.root.scrollIntoView({ block: "nearest", behavior: "smooth" });
    this.root.classList.remove("is-flash");
    void this.root.offsetWidth;
    this.root.classList.add("is-flash");
  }

  destroy() {
    this.offFrame?.();
    this.offChange?.();
    for (const plot of this.plots) plot.destroy();
    this.root.remove();
  }
}
