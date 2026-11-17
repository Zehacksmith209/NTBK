import katex from "katex";
import { SimGraph, Hover, graphColour, short } from "../sim/graphs.js";
import { registerObjectType } from "./registry.js";
import { createObject } from "../model/document.js";
import { Run, resolveParams } from "../sim/engine.js";
import { scenarioById } from "../sim/scenarios/index.js";
import { buildModelScenario, withParams, STARTER } from "../sim/model.js";
import { bridge } from "../bridge.js";

// ─────────────────────────────────────────────
//  SIMULATION BOX
//
//  A simulation that lives in the notes, like a
//  plot does: the scenario drawn and moving, and
//  its quantities graphed live underneath — any
//  quantity against any other.
//
//  The box itself is only the picture and the
//  graphs. Its controls are in the bar under the
//  ribbon while it is selected (SimBar), and its
//  inputs, model and results are in the Edit
//  panel (right-click → Edit, double-click, or
//  from the objects panel).
//
//  What is saved is the SET-UP, never the run:
//  which scenario, what was typed for each input
//  (units and variables included), the step and
//  speed, which graphs, saved configurations and
//  saved moments. The run itself is recomputed,
//  so a notebook stays small and always agrees
//  with its inputs.
// ─────────────────────────────────────────────
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];
export const STEPS = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02];
// How much of the run the graphs show; 0 is all of it
export const WINDOWS = [5, 10, 20, 60, 0];

/** The scenario a box runs: a built-in one, or one written in the box. */
export function scenarioFor(payload) {
  return payload.scenario === "model" ? buildModelScenario(payload.model ?? "") : scenarioById(payload.scenario);
}

export function createSimObject(x, y, scenarioId, modelText = STARTER) {
  const custom = scenarioId === "model";
  const scenario = custom ? buildModelScenario(modelText) : scenarioById(scenarioId);
  return createObject({
    type: "sim",
    x, y, w: 700, h: 500,      // fits inside an A4 page with its margins
    payload: {
      scenario: scenarioId,
      ...(custom ? { model: modelText } : {}),
      // A custom model's inputs live in its text; params only ever hold overrides there
      params: custom ? {} : Object.fromEntries((scenario?.params ?? []).map((p) => [p.key, p.default])),
      settings: { dt: 0.002, speed: 1, window: 10 },
      plots: scenario?.plots ?? [],
      presets: [],
      compare: null,
      moment: null,
    },
  });
}

const tex = (target, source, display = false) => {
  try {
    katex.render(source, target, { displayMode: display, throwOnError: true, strict: false });
  } catch {
    target.textContent = source;
  }
};

/** 0.0123 → "0.0123", 12345 → "1.23e4": readable at a glance, three figures. */
/** Everything a graph axis can show: time, and every quantity the model measures. */
export function quantitiesOf(scenario) {
  return {
    t: { label: "Time", symbol: "t", unit: "s" },
    ...scenario.outputs,
  };
}

/**
 * The graphs, as {x, y} pairs. Notebooks from before free axes stored lists
 * of quantities, each graphed against time; those read as the same graphs.
 */
export function plotsOf(payload, scenario) {
  const known = quantitiesOf(scenario);
  const asked = (payload.plots ?? []).flatMap((p) => (Array.isArray(p) ? p.map((y) => ({ x: "t", y })) : [p]));
  const valid = asked.filter((p) => known[p.x] && known[p.y]);
  // A model rewritten around new quantities: its old graph choices mean
  // nothing now, so show the scenario's own until some are chosen
  if (asked.length && !valid.length) return scenario.plots ?? [];
  return valid;
}

/** "v against x" — what a graph is, in words. */
export function graphName(graph, scenario) {
  const q = quantitiesOf(scenario);
  if (graph.label) return graph.label;
  // A plain symbol reads as itself; a typeset one (\mathrm{th}) falls back to its name
  const name = (key) => {
    const symbol = String(q[key].symbol ?? key);
    return /[\\{]/.test(symbol) ? key : symbol.replace(/_/g, "");
  };
  return graph.x === "t" ? `${name(graph.y)}(t)` : `${name(graph.y)} vs ${name(graph.x)}`;
}

const sameGraph = (a, b) => a.x === b.x && a.y === b.y;

/** A small <select> of every quantity, showing the chosen one. */
export function quantitySelect(scenario, value, title) {
  const select = document.createElement("select");
  select.title = title;
  for (const [key, def] of Object.entries(quantitiesOf(scenario))) {
    // A plain symbol is worth showing ("Position (x, m)"); a typeset one is not ("KE (J)")
    const symbol = /\\/.test(String(def.symbol ?? "")) ? "" : String(def.symbol ?? "").replace(/[{}_]/g, "");
    const extra = [symbol && symbol !== def.label ? symbol : "", def.unit].filter(Boolean).join(", ");
    select.add(new Option(extra ? `${def.label} (${extra})` : def.label, key));
  }
  select.value = value;
  return select;
}

registerObjectType("sim", {
  /**
   * A thin shell around the real box, so a model whose structure changed —
   * a new equation, a renamed quantity — can be rebuilt from scratch while
   * the controls bar keeps the same handle and the Edit panel stays open.
   */
  mount(el, object, context) {
    el.classList.add("ntbk-sim");
    const listeners = new Set();
    let lastNotice = 0;
    const notify = (tick = false) => {
      if (tick) {
        const now = performance.now();
        if (now - lastNotice < 100) return;
        lastNotice = now;
      }
      for (const fn of listeners) fn();
    };
    // Every frame drawn, for whatever else shows this run as it goes (the graphs panel)
    const frameListeners = new Set();
    const onFrame = () => { for (const fn of frameListeners) fn(); };
    let inner = mountSim(el, object, context, notify, {}, onFrame);
    const rebuild = (next) => {
      const carry = inner.carry();
      inner.destroy();
      el.innerHTML = "";
      el.classList.remove("is-playing");
      inner = mountSim(el, next, context, notify, carry, onFrame);
      notify();
    };
    const forward = (name) => (...args) => inner[name](...args);
    return {
      update(next) {
        if (inner.needsRebuild(next)) rebuild(next); else inner.update(next);
      },
      get title() { return inner.title; },
      get playing() { return inner.playing; },
      get t() { return inner.t; },
      get settings() { return inner.settings; },
      get editing() { return inner.editing; },
      get comparing() { return inner.comparing; },
      get presetCount() { return inner.presetCount; },
      get hasMoment() { return inner.hasMoment; },
      get run() { return inner.run; },
      play: forward("play"), pause: forward("pause"), reset: forward("reset"), stepOnce: forward("stepOnce"),
      toggle: forward("toggle"), setSetting: forward("setSetting"), openMenu: forward("openMenu"),
      exportCsv: forward("exportCsv"), edit: forward("edit"), closeEdit: forward("closeEdit"),
      id: object.id,
      get scenario() { return inner.scenario; },
      get ghost() { return inner.ghost; },
      get payload() { return inner.payload; },
      refreshGraphBar: forward("refreshGraphBar"),
      /** Called after every frame is drawn; returns a function that stops it. */
      onFrame(fn) {
        frameListeners.add(fn);
        return () => frameListeners.delete(fn);
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      destroy() {
        inner.destroy();
        notify();
        listeners.clear();
        frameListeners.clear();
      },
    };
  },
});

function mountSim(el, object, context, notify, carry, onFrame = () => {}) {
  {
    let scenario = scenarioFor(object.payload);
    if (!scenario) {
      el.innerHTML = `<div class="ntbk-sim-missing">This simulation (“${object.payload.scenario}”)
        is not in this version of ntbk.</div>`;
      return { update() {}, destroy() {}, needsRebuild: () => false, carry: () => ({}), title: "Simulation",
               playing: false, t: 0, settings: {}, editing: false, comparing: null, presetCount: 0, hasMoment: false,
               run: null, play() {}, pause() {}, reset() {}, stepOnce() {}, toggle() {}, setSetting() {},
               openMenu() {}, exportCsv() {}, edit() {}, closeEdit() {}, refreshGraphBar() {},
               scenario: null, ghost: null, payload: object.payload };
    }
    const custom = !!scenario.custom;

    // Drawn as shapes (SVG) when the scenario can, else on a canvas
    el.innerHTML = `
      <div class="ntbk-sim-stage">
        ${scenario.render ? `<svg class="ntbk-sim-view ntbk-sim-svg"></svg>` : `<canvas class="ntbk-sim-view"></canvas>`}
        <span class="ntbk-sim-time">t = 0.00 s</span>
      </div>
      <div class="ntbk-sim-graphbar"></div>
      <div class="ntbk-sim-plots"></div>`;

    const $ = (selector) => el.querySelector(selector);
    const view = $(".ntbk-sim-view");
    const plotsHost = $(".ntbk-sim-plots");
    const timeLabel = $(".ntbk-sim-time");
    const quantities = quantitiesOf(scenario);

    // Graph controls take the pointer for themselves: picking an axis must
    // not also start a pen stroke or a drag of the whole box
    for (const part of el.querySelectorAll(".ntbk-sim-graphbar, .ntbk-sim-plots")) {
      part.addEventListener("pointerdown", (event) => event.stopPropagation());
    }

    let payload = object.payload;
    let resolved = resolveParams(scenario, payload.params);
    let run = new Run(scenario, resolved.values, { dt: payload.settings?.dt ?? 0.002 });
    let ghost = null;          // a second run, from a saved configuration, to compare against
    let playing = false;
    let ended = false;
    let frame = 0, last = 0;
    let plots = [];
    const hover = new Hover();  // the instant pointed at on any of this box's graphs

    let destroyed = false;
    function save(patch, label = "Edit simulation") {
      context.updateObjectPayload(object.id, { ...payload, ...patch }, label);
    }

    // ───────────────── Edit panel ─────────────────
    //
    // Built once and kept, open or not, so the inputs and results stay up to
    // date without being rebuilt every time it is opened.
    const panel = document.createElement("div");
    panel.className = "ntbk-sim-panel";
    panel.innerHTML = `
      <div class="ntbk-sim-panel-head">
        <strong></strong>
        <button class="ntbk-ge-close" data-done title="Close (Esc)">Done</button>
      </div>
      <div class="ntbk-sim-panel-body">
        ${custom ? `
        <div class="ntbk-sim-section">Equations</div>
        <div class="ntbk-sim-modelwrap">
          <textarea class="ntbk-sim-model" spellcheck="false"></textarea>
          <div class="ntbk-sim-modelerrors"></div>
          <details class="ntbk-sim-modelhelp"><summary>How to write a model</summary>
            <div><code>m*x'' + k*x = 0</code> — an equation of motion; <code>x'</code> and <code>x''</code> are rates</div>
            <div><code>k = 40 N/m</code> — an input (units optional, notebook variables allowed)</div>
            <div><code>x(0) = 0.2 m</code> — where it starts</div>
            <div><code>E = 1/2*k*x^2</code> — a quantity to graph</div>
            <div><code>stop when s >= L</code> — end the run when this holds</div>
            <div><code>graph v against x</code> — a graph to offer; the first three open with the box</div>
            <div><code>draw block at (x, 0) size 0.2 angle -theta</code> — shapes: ground, wall, spring, damper, rod, string, line, block, circle, point, pivot, arrow, trace, label</div>
            <div><code># Title</code> — a name; <code>view -1 -1 1 1</code> — a fixed view</div>
            <div>⌘↩ or click away to apply.</div>
          </details>
        </div>` : ""}
        <div class="ntbk-sim-section">Inputs</div>
        <div class="ntbk-sim-params"></div>
        <div class="ntbk-sim-section">Graphs</div>
        <div class="ntbk-sim-graphlist"></div>
        <div class="ntbk-sim-section">Model</div>
        <div class="ntbk-sim-equations"></div>
        <div class="ntbk-sim-section">Results</div>
        <div class="ntbk-sim-readouts"></div>
      </div>`;
    const p$ = (selector) => panel.querySelector(selector);
    p$(".ntbk-sim-panel-head strong").textContent = scenario.title;
    if (custom) panel.classList.add("is-custom");

    // ── The model text, for a box written as equations ──
    const modelArea = p$(".ntbk-sim-model");
    const modelErrors = p$(".ntbk-sim-modelerrors");
    function showModel() {
      if (!modelArea) return;
      if (document.activeElement !== modelArea) modelArea.value = payload.model ?? "";
      modelArea.rows = Math.min(30, Math.max(6, (payload.model ?? "").split("\n").length + 1));
      modelErrors.innerHTML = "";
      for (const e of scenario.errors ?? []) {
        const row = document.createElement("div");
        row.className = "ntbk-sim-modelerror";
        row.textContent = e.line >= 0 ? `line ${e.line + 1}: ${e.message}` : e.message;
        if (e.line >= 0) {
          row.title = "Click to go to this line";
          row.addEventListener("click", () => selectLine(e.line));
        }
        modelErrors.appendChild(row);
      }
    }
    function selectLine(line) {
      const lines = (modelArea.value ?? "").split("\n");
      const start = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
      modelArea.focus();
      modelArea.setSelectionRange(start, start + lines[line].length);
    }
    function commitModel() {
      if (destroyed) return;             // a blur arriving after this box was rebuilt
      const text = modelArea.value;
      if (text === (payload.model ?? "")) return;
      carry.modelCaret = modelArea.selectionStart;
      save({ model: text }, "Edit model");
    }
    if (modelArea) {
      modelArea.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commitModel(); }
        if (event.key === "Tab") {
          event.preventDefault();
          const at = modelArea.selectionStart;
          modelArea.setRangeText("  ", at, modelArea.selectionEnd, "end");
        }
      });
      modelArea.addEventListener("change", commitModel);
      modelArea.addEventListener("blur", commitModel);
    }
    p$("[data-done]").addEventListener("click", () => closePanel());
    // Pressing Done commits the text (the textarea loses focus), which can
    // rebuild the box before the click lands: remember that Done was meant
    let closing = false;
    p$("[data-done]").addEventListener("pointerdown", () => {
      closing = true;
      window.addEventListener("pointerup", () => setTimeout(() => { closing = false; }), { once: true });
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.stopPropagation(); closePanel(); }
    });

    // Drag the panel by its head, out of the way of what it is editing
    p$(".ntbk-sim-panel-head").addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const start = { x: event.clientX, y: event.clientY,
                      left: panel.offsetLeft, top: panel.offsetTop };
      const move = (e) => {
        panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, start.left + e.clientX - start.x))}px`;
        panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 30, start.top + e.clientY - start.y))}px`;
      };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    const onPanelEscape = (event) => {
      if (event.key === "Escape" && panel.isConnected
          && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName ?? "")) closePanel();
    };

    function openPanel() {
      if (!panel.isConnected) {
        document.body.appendChild(panel);
        window.addEventListener("keydown", onPanelEscape);
      }
      // Beside the box if there is room, otherwise wherever it fits
      // Never over the ribbon or the controls bar: it starts where the canvas does
      const area = el.closest("#canvas-host")?.getBoundingClientRect();
      const top = (area?.top ?? 8) + 8;
      panel.style.maxHeight = `${Math.max(200, window.innerHeight - top - 8)}px`;
      const box = el.getBoundingClientRect();
      const width = panel.offsetWidth || 270;
      const height = panel.offsetHeight || 500;
      let x = box.right + 10;
      if (x + width > window.innerWidth - 8) x = box.left - width - 10;
      if (x < 8) x = window.innerWidth - width - 8;
      const y = Math.max(top, Math.min(box.top, window.innerHeight - height - 8));
      panel.style.left = `${Math.round(x)}px`;
      panel.style.top = `${Math.round(y)}px`;
      showModel();
      showParams();
      showReadouts();
      notify();
    }

    function closePanel() {
      if (!panel.isConnected) return;
      panel.remove();
      window.removeEventListener("keydown", onPanelEscape);
      notify();
    }

    el.addEventListener("ntbk:edit", openPanel);
    if (carry.panelOpen) {
      queueMicrotask(() => {
        openPanel();
        if (carry.panelPos) { panel.style.left = carry.panelPos[0]; panel.style.top = carry.panelPos[1]; }
        if (carry.modelCaret != null && modelArea) {
          modelArea.focus();
          const at = Math.min(carry.modelCaret, modelArea.value.length);
          modelArea.setSelectionRange(at, at);
        }
      });
    }
    const onDoubleClick = (event) => {
      if (event.target.closest(".ntbk-sim-graphbar, .ntbk-sim-plots select, .ntbk-sim-plot-x")) return;
      event.stopPropagation();
      openPanel();
    };
    el.addEventListener("dblclick", onDoubleClick);

    // ── Inputs ──
    const paramsHost = p$(".ntbk-sim-params");
    const rows = new Map();
    for (const def of scenario.params) {
      const row = document.createElement("div");
      row.className = "ntbk-sim-param";
      row.innerHTML = `
        <div class="ntbk-sim-param-head"><span class="ntbk-sim-sym"></span><span class="ntbk-sim-name"></span></div>
        <input type="text" spellcheck="false">
        <input type="range">
        <div class="ntbk-sim-hint"></div>`;
      tex(row.querySelector(".ntbk-sim-sym"), def.symbol);
      row.querySelector(".ntbk-sim-name").textContent = def.label + (def.initial ? " (at start)" : "");
      const text = row.querySelector("input[type=text]");
      const slider = row.querySelector("input[type=range]");
      Object.assign(slider, { min: def.min, max: def.max, step: (def.max - def.min) / 200 });
      text.title = `A number in ${def.unit}, a value with a unit, or a notebook variable such as k or 2*k`;

      text.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") text.blur();
      });
      text.addEventListener("change", () => setParam(def.key, text.value.trim()));
      // Dragging the slider runs live; the notebook records it once, on release
      slider.addEventListener("input", () => {
        const value = `${+Number(slider.value).toPrecision(4)} ${def.unit}`;
        text.value = value;
        applyParams({ ...payload.params, [def.key]: value });
      });
      // Read the slider itself: the text box is refreshed from the saved
      // value during the drag, so it no longer says what the slider does
      slider.addEventListener("change", () =>
        setParam(def.key, `${+Number(slider.value).toPrecision(4)} ${def.unit}`.trim()));
      paramsHost.appendChild(row);
      rows.set(def.key, { row, text, slider, hint: row.querySelector(".ntbk-sim-hint"), def });
    }

    for (const line of scenario.equations ?? []) {
      const eq = document.createElement("div");
      eq.className = "ntbk-sim-eq";
      tex(eq, line, true);
      p$(".ntbk-sim-equations").appendChild(eq);
    }
    for (const note of scenario.notes ?? []) {
      const row = document.createElement("div");
      row.className = "ntbk-sim-note" + (note.bad ? " is-bad" : "");
      row.textContent = `${note.bad ? "⚠" : "✓"} ${note.text}`;
      p$(".ntbk-sim-equations").appendChild(row);
    }

    function showParams() {
      for (const [key, { text, slider, hint, def }] of rows) {
        const typed = String(payload.params?.[key] ?? def.default);
        if (document.activeElement !== text) text.value = typed;
        slider.value = String(resolved.values[key]);
        const error = resolved.errors[key];
        const links = resolved.links[key];
        hint.classList.toggle("is-bad", !!error);
        hint.textContent = error
          ? error
          : links?.length ? `uses ${links.join(", ")} → ${short(resolved.values[key])} ${def.unit}`
          : def.initial && run.t > 0 ? "applies on reset" : "";
      }
    }

    /**
     * Use new inputs. Most take effect at once, mid-run — that is what makes
     * a stiffness slider feel like turning a real knob. Starting conditions
     * cannot change the past, so they wait for a reset, unless the run is
     * still at its very start.
     */
    function applyParams(typedParams) {
      const before = resolved.values;
      resolved = resolveParams(scenario, typedParams);
      run.params = resolved.values;
      const startChanged = scenario.params.some((d) => d.initial && before[d.key] !== resolved.values[d.key]);
      if (startChanged && run.t === 0) run.reset(resolved.values);
      showParams();
      showReadouts();
      draw();
    }

    /** A custom model keeps its inputs in the text itself; built-in ones in params. */
    function setParam(key, value) {
      if (custom) save({ model: withParams(payload.model, { [key]: value }) }, "Change input");
      else save({ params: { ...payload.params, [key]: value } }, "Change input");
    }
    const typedParams = () => Object.fromEntries(scenario.params.map((d) => [d.key, payload.params?.[d.key] ?? d.default]));

    // ── Results ──
    const readoutsHost = p$(".ntbk-sim-readouts");
    const liveValues = new Map();
    function showReadouts() {
      readoutsHost.innerHTML = "";
      const add = (symbol, value, unit, note) => {
        const row = document.createElement("div");
        row.className = "ntbk-sim-readout";
        const sym = document.createElement("span");
        tex(sym, symbol);
        const val = document.createElement("span");
        val.className = "ntbk-sim-value";
        val.textContent = `${short(value)}${unit ? ` ${unit}` : ""}${note ? ` · ${note}` : ""}`;
        row.append(sym, val);
        readoutsHost.appendChild(row);
        return val;
      };
      for (const r of scenario.readouts?.(run.params) ?? []) add(r.symbol, r.value, r.unit, r.note);
      liveValues.clear();
      for (const [key, def] of Object.entries(scenario.outputs)) {
        liveValues.set(key, add(def.symbol ?? key, NaN, def.unit));
      }
      showLive();
    }
    function showLive() {
      if (!panel.isConnected) return;
      const now = run.measure();
      for (const [key, node] of liveValues) {
        const def = scenario.outputs[key];
        node.textContent = `${short(now[key])}${def.unit ? ` ${def.unit}` : ""}`;
      }
    }

    // ───────────────── Graphs ─────────────────
    function setPlots(next, label = "Choose graphs") {
      save({ plots: next }, label);
    }

    /** One-click graphs along the top, like a camera preset: on or off. */
    const graphBar = $(".ntbk-sim-graphbar");
    function showGraphBar() {
      graphBar.innerHTML = "";
      const current = plotsOf(payload, scenario);
      const quick = scenario.graphs ?? Object.keys(scenario.outputs).map((y) => ({ x: "t", y }));
      for (const graph of quick) {
        const on = current.some((g) => sameGraph(g, graph));
        const chip = document.createElement("button");
        chip.className = "ntbk-sim-chip";
        chip.classList.toggle("is-on", on);
        chip.textContent = graphName(graph, scenario);
        chip.title = `${quantities[graph.y].label} against ${quantities[graph.x].label.toLowerCase()} — `
          + (on ? "click to hide" : "click to show");
        chip.addEventListener("click", () => {
          const pair = { x: graph.x, y: graph.y };
          setPlots(on ? current.filter((g) => !sameGraph(g, graph)) : [...current, pair]);
        });
        graphBar.appendChild(chip);
      }
      const add = document.createElement("button");
      add.className = "ntbk-sim-chip is-add";
      add.textContent = "+ Graph";
      add.title = "Add a graph, then pick what goes on each axis";
      add.addEventListener("click", () => {
        // Something not already shown, against time, as a starting point
        const keys = Object.keys(scenario.outputs);
        const y = keys.find((k) => !current.some((g) => g.x === "t" && g.y === k)) ?? keys[0];
        setPlots([...current, { x: "t", y }], "Add graph");
      });
      graphBar.appendChild(add);
      // Also in the graphs panel on the right? Its colour here says which section is this one
      const panel = context.graphsPanel?.();
      if (panel) {
        const inPanel = panel.has(object.id);
        const out = document.createElement("button");
        out.className = "ntbk-sim-chip is-dock";
        out.classList.toggle("is-on", inPanel);
        if (inPanel) {
          const dot = document.createElement("i");
          dot.className = "ntbk-sim-tag";
          dot.style.background = panel.colourOf(object.id);
          out.append(dot, "In graphs panel");
          out.title = "These graphs are also in the panel on the right. Click to take them out of it";
        } else {
          out.textContent = "⇥ Graphs panel";
          out.title = "Also show this simulation's graphs in the panel on the right: taller, stacked, room for more";
        }
        out.addEventListener("click", () => panel.toggle(object.id));
        graphBar.appendChild(out);
      }
    }

    /** The same choice, as a list, in the Edit panel. */
    const graphList = p$(".ntbk-sim-graphlist");
    function showGraphList() {
      graphList.innerHTML = "";
      const current = plotsOf(payload, scenario);
      current.forEach((graph, index) => {
        const row = document.createElement("div");
        row.className = "ntbk-sim-graphrow";
        axisControls(row, graph, index, current);
        graphList.appendChild(row);
      });
      const add = document.createElement("button");
      add.className = "ntbk-mini";
      add.textContent = "+ Add graph";
      add.addEventListener("click", () => {
        const keys = Object.keys(scenario.outputs);
        const y = keys.find((k) => !current.some((g) => g.x === "t" && g.y === k)) ?? keys[0];
        setPlots([...current, { x: "t", y }], "Add graph");
      });
      graphList.appendChild(add);
    }

    /** "[y] against [x] ×" — the two axes of one graph, each any quantity. */
    function axisControls(host, graph, index, current) {
      const y = quantitySelect(scenario, graph.y, "Up the side");
      const x = quantitySelect(scenario, graph.x, "Along the bottom");
      const against = document.createElement("span");
      against.textContent = "against";
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = "Remove this graph";
      const change = (patch) => {
        const next = current.map((g, i) => (i === index ? { x: g.x, y: g.y, ...patch } : { x: g.x, y: g.y }));
        setPlots(next, "Change graph axes");
      };
      y.addEventListener("change", () => change({ y: y.value }));
      x.addEventListener("change", () => change({ x: x.value }));
      remove.addEventListener("click", () =>
        setPlots(current.filter((_, i) => i !== index), "Remove graph"));
      for (const control of [y, x]) control.addEventListener("keydown", (e) => e.stopPropagation());
      host.append(y, against, x, remove);
    }

    /**
     * One graph per {x, y} pair, stacked. Graphs against time share a sliding
     * time window and a cursor: hover one and every graph marks the same
     * instant — on a graph of v against x that instant is a ring on the curve.
     */
    function buildPlots() {
      for (const plot of plots) plot.destroy();
      plots = [];
      plotsHost.innerHTML = "";
      const graphs = plotsOf(payload, scenario);
      plotsHost.hidden = !graphs.length;
      if (!graphs.length) return;
      // Graphs against time stack in one column; x–y graphs (a phase portrait,
      // force against extension) want to be squarer, so they get their own
      const overTime = graphs.filter((g) => g.x === "t").length;
      const across = graphs.length - overTime;
      const both = overTime && across;
      const columns = {
        time: document.createElement("div"),
        xy: document.createElement("div"),
      };
      for (const column of Object.values(columns)) {
        column.className = "ntbk-sim-col";
        plotsHost.appendChild(column);
      }
      const fullWidth = Math.max(160, plotsHost.clientWidth);
      const fullHeight = plotsHost.clientHeight;
      const timeWidth = both ? Math.round(fullWidth * 0.6) : fullWidth;
      const sizeFor = (isTime) => {
        if (isTime) return { width: timeWidth, height: Math.max(54, Math.floor(fullHeight / overTime)) };
        // Side by side when there are no time graphs, stacked beside them when there are
        return both
          ? { width: fullWidth - timeWidth, height: Math.max(54, Math.floor(fullHeight / across)) }
          : { width: Math.floor(fullWidth / across), height: Math.max(54, fullHeight) };
      };
      plotsHost.classList.toggle("is-across", !overTime);

      graphs.forEach((graph, index) => {
        const isTime = graph.x === "t";
        const plot = new SimGraph({
          graph, colour: graphColour(scenario, graph, index), ...sizeFor(isTime),
          syncKey: `sim-${object.id}`, hover, compare: !!ghost,
        });
        axisControls(plot.controls, graph, index, graphs);
        if (ghost) {
          const note = document.createElement("span");
          note.className = "ntbk-sim-ghostnote";
          note.textContent = `dashed: ${payload.compare}`;
          plot.controls.appendChild(note);
        }
        (isTime ? columns.time : columns.xy).appendChild(plot.holder);
        plots.push(plot);
      });
      updatePlots();
    }

    function updatePlots() {
      const span = payload.settings?.window ?? 10;
      for (const plot of plots) plot.update(run, ghost, span);
    }

    // ───────────────── Running ─────────────────
    function draw() {
      if (scenario.render) scenario.render(view, run, ghost); else scenario.draw(view, run, ghost);
      timeLabel.textContent = `t = ${run.t.toFixed(2)} s`;
      updatePlots();
      onFrame();
      showLive();
    }

    function tick(now) {
      if (!playing) return;
      const real = Math.min(0.05, (now - last) / 1000);   // a stalled tab must not leap
      last = now;
      const speed = payload.settings?.speed ?? 1;
      const going = run.advance(real * speed);
      ghost?.advance(real * speed);
      draw();
      notify(true);
      if (!going) { ended = true; pause(); return; }
      frame = requestAnimationFrame(tick);
    }

    function play() {
      if (playing) return;
      if (ended) reset();
      playing = true;
      el.classList.add("is-playing");
      last = performance.now();
      frame = requestAnimationFrame(tick);
      notify();
    }

    function pause() {
      playing = false;
      cancelAnimationFrame(frame);
      el.classList.remove("is-playing");
      showParams();
      notify();
    }

    function reset() {
      ended = false;
      run.reset(resolved.values);
      if (ghost) startGhost();
      showParams();
      draw();
      notify();
    }

    /** One frame's worth of time, while paused: for looking at a moment closely. */
    function stepOnce() {
      if (playing) pause();
      if (ended) return;                 // the run has finished: Play starts it again
      const going = run.advance(1 / 60 * (payload.settings?.speed ?? 1));
      ghost?.advance(1 / 60 * (payload.settings?.speed ?? 1));
      if (!going) ended = true;
      draw();
      notify();
    }

    function startGhost() {
      const preset = (payload.presets ?? []).find((p) => p.name === payload.compare);
      ghost = preset
        ? new Run(scenario, resolveParams(scenario, preset.params).values, { dt: run.dt })
        : null;
    }

    const onSpace = (event) => {
      if (event.key === " " && !/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) {
        event.preventDefault(); event.stopPropagation();
        playing ? pause() : play();
      }
    };
    el.addEventListener("keydown", onSpace);

    // ───────── Configurations, moments, export ─────────
    //
    // Opened from the controls bar. They float over everything, so they live
    // on the page body rather than inside the (zoomed) box.
    let openMenuEl = null;
    function closeMenu() {
      openMenuEl?.remove();
      openMenuEl = null;
    }

    function openMenu(anchor, part) {
      closeMenu();
      const menu = document.createElement("div");
      menu.className = "ntbk-sim-menu";
      const item = (text, title, act, disabled = false) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener("click", () => { closeMenu(); act(); });
        menu.appendChild(b);
        return b;
      };
      const head = (text) => {
        const h = document.createElement("div");
        h.className = "ntbk-sim-menu-head";
        h.textContent = text;
        menu.appendChild(h);
      };

      if (part === "configs") {
        head("Configurations");
        const nameRow = document.createElement("div");
        nameRow.className = "ntbk-sim-menu-row";
        const name = document.createElement("input");
        name.placeholder = "Name these inputs";
        name.spellcheck = false;
        const add = document.createElement("button");
        add.textContent = "Save";
        const savePreset = () => {
          const label = name.value.trim() || `Set-up ${(payload.presets?.length ?? 0) + 1}`;
          const presets = [...(payload.presets ?? []).filter((p) => p.name !== label),
                           { name: label, params: typedParams() }];
          closeMenu();
          save({ presets }, "Save configuration");
        };
        add.addEventListener("click", savePreset);
        name.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") savePreset(); });
        nameRow.append(name, add);
        menu.appendChild(nameRow);
        if (!payload.presets?.length) {
          const note = document.createElement("div");
          note.className = "ntbk-sim-menu-note";
          note.textContent = "Save the inputs under a name, then switch back to them or run one alongside to compare.";
          menu.appendChild(note);
        }
        for (const preset of payload.presets ?? []) {
          const row = document.createElement("div");
          row.className = "ntbk-sim-menu-row";
          const use = document.createElement("button");
          use.className = "is-grow";
          use.textContent = `Use “${preset.name}”`;
          use.addEventListener("click", () => {
            closeMenu();
            if (custom) save({ model: withParams(payload.model, preset.params) }, "Use configuration");
            else save({ params: { ...preset.params } }, "Use configuration");
          });
          const cmp = document.createElement("button");
          cmp.textContent = payload.compare === preset.name ? "Comparing" : "Compare";
          cmp.title = "Run this configuration alongside, dashed on the graphs";
          cmp.addEventListener("click", () => {
            closeMenu();
            save({ compare: payload.compare === preset.name ? null : preset.name }, "Compare configurations");
          });
          const del = document.createElement("button");
          del.textContent = "×";
          del.title = "Delete this configuration";
          del.addEventListener("click", () => {
            closeMenu();
            save({ presets: payload.presets.filter((p) => p !== preset),
                   compare: payload.compare === preset.name ? null : payload.compare }, "Delete configuration");
          });
          row.append(use, cmp, del);
          menu.appendChild(row);
        }
        if (!custom) {
          head("Inputs");
          item("Reset inputs to defaults", "Put every input back as it was when inserted", () =>
            save({ params: Object.fromEntries(scenario.params.map((p) => [p.key, p.default])) }, "Reset inputs"));
        }
      } else {
        head("This moment");
        item(`Save the state at t = ${run.t.toFixed(2)} s`, "Keep this exact moment in the notebook, to come back to",
          () => save({ moment: { ...run.snapshot(), params: { ...payload.params } } }, "Save simulation state"),
          !run.stepper.y);
        item(payload.moment ? `Go back to t = ${payload.moment.t.toFixed(2)} s` : "No saved state yet",
          "Restore the saved moment and carry on from there", () => {
            pause();
            run.restore(payload.moment);
            draw();
            notify();
          }, !payload.moment);
      }

      menu.addEventListener("pointerdown", (e) => e.stopPropagation());
      document.body.appendChild(menu);
      const a = anchor.getBoundingClientRect();
      menu.style.top = `${Math.round(a.bottom + 4)}px`;
      menu.style.left = `${Math.round(Math.max(8, Math.min(a.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
      openMenuEl = menu;
      setTimeout(() => document.addEventListener("pointerdown", function away(e) {
        if (openMenuEl === menu && menu.contains(e.target)) return;
        document.removeEventListener("pointerdown", away, true);
        if (openMenuEl === menu) closeMenu();
      }, true), 0);
    }

    async function exportCsv() {
      const name = `${scenario.title.replace(/[^\w\- ]+/g, "")} results.csv`;
      const result = await bridge.saveText(name, run.toCSV(), "CSV");
      if (result?.ok) context.flash?.(`Saved ${result.name}`);
      else if (result && !result.cancelled) context.flash?.(result.error ?? "Could not save the results");
    }

    // ───────── Keeping up with the notebook ─────────
    const onVariables = () => applyParams(payload.params);
    window.addEventListener("ntbk:variables", onVariables);
    const resize = new ResizeObserver(() => { buildPlots(); draw(); });
    resize.observe(plotsHost);
    const themeWatch = new MutationObserver(() => { buildPlots(); draw(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    function apply(next) {
      const before = payload;
      payload = next.payload;
      run.dt = payload.settings?.dt ?? 0.002;
      let inputsChanged = JSON.stringify(before.params) !== JSON.stringify(payload.params) || !before.params;
      if (custom && before.model !== payload.model) {
        // Same equations, new numbers: take the new defaults without a restart
        const fresh = buildModelScenario(payload.model);
        for (const def of fresh.params) {
          const mine = scenario.params.find((d) => d.key === def.key);
          if (mine) mine.default = def.default;
        }
        showModel();
        inputsChanged = true;
      }
      if (inputsChanged) applyParams(payload.params);
      if (before.compare !== payload.compare || JSON.stringify(before.presets) !== JSON.stringify(payload.presets)) {
        startGhost();
        if (ghost) { run.reset(resolved.values); }
      }
      if (JSON.stringify(before.plots) !== JSON.stringify(payload.plots) || before.compare !== payload.compare) {
        showGraphBar();
        showGraphList();
        buildPlots();
      }
      if (before.settings?.window !== payload.settings?.window) updatePlots();
      draw();
      notify();
    }

    startGhost();
    showGraphBar();
    showGraphList();
    showParams();
    showReadouts();
    // Built now, so a box mounted while the window is hidden (a notebook tab
    // in the background) is complete the moment it is looked at; built again
    // on the first frame, when fonts and sizes are settled
    buildPlots();
    draw();
    requestAnimationFrame(() => { buildPlots(); draw(); });

    // What the controls bar drives
    return {
      update(next) {
        object = next;
        if (next.payload !== payload) apply(next);
      },
      /** A model whose shape changed (not just its numbers) needs a fresh box. */
      needsRebuild(next) {
        if (!custom || next.payload.model === payload.model) return false;
        return buildModelScenario(next.payload.model).signature !== scenario.signature;
      },
      /** What a rebuild keeps: the open panel, where it is, the cursor in the text. */
      carry() {
        return {
          panelOpen: panel.isConnected && !closing,
          panelPos: panel.isConnected ? [panel.style.left, panel.style.top] : null,
          modelCaret: modelArea && document.activeElement === modelArea ? modelArea.selectionStart : carry.modelCaret,
        };
      },
      title: scenario.title,
      get playing() { return playing; },
      get t() { return run.t; },
      get settings() { return payload.settings ?? {}; },
      get editing() { return panel.isConnected; },
      get comparing() { return payload.compare; },
      get presetCount() { return payload.presets?.length ?? 0; },
      get hasMoment() { return !!payload.moment; },
      get run() { return run; },
      play, pause, reset, stepOnce,
      toggle() { playing ? pause() : play(); },
      setSetting(key, value) {
        const labels = { speed: "Simulation speed", dt: "Simulation step", window: "Graph window" };
        save({ settings: { ...payload.settings, [key]: value } }, labels[key] ?? "Simulation setting");
      },
      openMenu,
      exportCsv,
      edit: openPanel,
      closeEdit: closePanel,
      // What the graphs panel reads to draw its own copies of these graphs
      get scenario() { return scenario; },
      get ghost() { return ghost; },
      get payload() { return payload; },
      /** The chips' "in the panel" state changed: show it. */
      refreshGraphBar() { showGraphBar(); },
      destroy() {
        destroyed = true;
        playing = false;
        cancelAnimationFrame(frame);
        closePanel();
        // el outlives this mount (a rebuild reuses it): an old listener would
        // open this old panel, with its old text, beside the new one
        el.removeEventListener("ntbk:edit", openPanel);
        el.removeEventListener("dblclick", onDoubleClick);
        el.removeEventListener("keydown", onSpace);
        closeMenu();
        window.removeEventListener("ntbk:variables", onVariables);
        resize.disconnect();
        themeWatch.disconnect();
        for (const plot of plots) plot.destroy();
      },
    };
  }
}
