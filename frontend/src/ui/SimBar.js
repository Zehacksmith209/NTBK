import { createIcons, icons } from "lucide";
import { SPEEDS, STEPS, WINDOWS } from "../objects/SimBox.js";

// ─────────────────────────────────────────────
//  SIMULATION BAR
//
//  The controls of the selected simulation, in
//  a strip under the ribbon: play, reset, step,
//  speed, the solver's time step, how much of
//  the run the graphs show, configurations,
//  saved moments, export and Edit.
//
//  It shows while a simulation is selected, and
//  stays while one is running even after you
//  click away — so a running simulation can
//  always be stopped.
// ─────────────────────────────────────────────
export class SimBar {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.id = null;
    this.handle = null;
    this.off = null;

    host.className = "ntbk-simbar is-hidden";
    host.innerHTML = `
      <span class="ntbk-simbar-title"><i data-lucide="atom"></i><span></span></span>
      <span class="ntbk-simbar-group">
        <button class="ntbk-simbar-btn is-primary" data-play title="Play / pause"><i data-lucide="play"></i><span>Play</span></button>
        <button class="ntbk-simbar-btn" data-reset title="Back to the start"><i data-lucide="rotate-ccw"></i><span>Reset</span></button>
        <button class="ntbk-simbar-btn" data-step title="Forward one frame"><i data-lucide="step-forward"></i></button>
        <span class="ntbk-simbar-time">t = 0.00 s</span>
      </span>
      <span class="ntbk-simbar-group">
        <label title="How fast simulated time runs against real time">Speed <select data-speed></select></label>
        <label title="The time step the equations are solved with. Smaller is more accurate and slower.">Step <select data-dt></select></label>
        <label title="How much of the run the graphs show">Graphs show <select data-window></select></label>
      </span>
      <span class="ntbk-simbar-group">
        <button class="ntbk-simbar-btn" data-configs title="Save the inputs under a name, switch between them, compare two"><i data-lucide="sliders-horizontal"></i><span>Configurations</span></button>
        <button class="ntbk-simbar-btn" data-moment title="Save this exact moment, or go back to one"><i data-lucide="bookmark"></i><span>Moment</span></button>
        <button class="ntbk-simbar-btn" data-csv title="Every recorded sample as CSV, with units"><i data-lucide="file-down"></i><span>Export CSV</span></button>
        <button class="ntbk-simbar-btn" data-dock title="Also show this simulation's graphs in the panel on the right, stacked and taller"><i data-lucide="panel-right"></i><span>Graphs panel</span></button>
      </span>
      <span class="ntbk-simbar-spacer"></span>
      <button class="ntbk-simbar-btn is-edit" data-edit title="Inputs, graphs, model and results"><i data-lucide="pencil"></i><span>Edit</span></button>`;
    createIcons({ icons, root: host });

    const $ = (selector) => host.querySelector(selector);
    this.titleEl = $(".ntbk-simbar-title span");
    this.playButton = $("[data-play]");
    this.timeEl = $(".ntbk-simbar-time");
    this.speed = $("[data-speed]");
    this.dt = $("[data-dt]");
    this.window = $("[data-window]");
    this.editButton = $("[data-edit]");
    this.configsButton = $("[data-configs]");
    this.dockButton = $("[data-dock]");

    for (const s of SPEEDS) this.speed.add(new Option(`${s}×`, String(s)));
    for (const s of STEPS) this.dt.add(new Option(`${+(s * 1000).toPrecision(3)} ms`, String(s)));
    for (const s of WINDOWS) this.window.add(new Option(s ? `last ${s} s` : "whole run", String(s)));

    const act = (selector, fn) => $(selector).addEventListener("click", (event) => {
      if (this.handle) fn(this.handle, event.currentTarget);
    });
    act("[data-play]", (h) => h.toggle());
    act("[data-reset]", (h) => { h.pause(); h.reset(); });
    act("[data-step]", (h) => h.stepOnce());
    act("[data-configs]", (h, button) => h.openMenu(button, "configs"));
    act("[data-moment]", (h, button) => h.openMenu(button, "moment"));
    act("[data-csv]", (h) => h.exportCsv());
    act("[data-dock]", () => this.app.graphsPanel?.toggle(this.id));
    act("[data-edit]", (h) => (h.editing ? h.closeEdit() : h.edit()));
    this.speed.addEventListener("change", () => this.handle?.setSetting("speed", Number(this.speed.value)));
    this.dt.addEventListener("change", () => this.handle?.setSetting("dt", Number(this.dt.value)));
    this.window.addEventListener("change", () => this.handle?.setSetting("window", Number(this.window.value)));

    // Mounting happens inside the store's own update, so look once it is done
    app.store.subscribe(() => queueMicrotask(() => this.refresh()));
  }

  /** Which simulation, if any, the bar is for now. */
  refresh() {
    const ids = [...this.app.selection];
    const one = ids.length === 1 ? this.app.store.find(ids[0]) : null;
    let id = one?.type === "sim" ? one.id : null;
    // Clicked away from a running simulation: keep its controls, so it can be stopped
    if (!id && this.id && this.app.store.find(this.id) && this.handle?.playing) id = this.id;
    this.bind(id);
  }

  bind(id) {
    const handle = id ? this.app.objectHandle(id) : null;
    if (handle && id === this.id && handle === this.handle) return this.render();
    this.off?.();
    this.off = null;
    this.id = handle ? id : null;
    this.handle = handle?.subscribe ? handle : null;
    this.host.classList.toggle("is-hidden", !this.handle);
    if (!this.handle) return;
    this.off = this.handle.subscribe(() => this.changed());
    this.render();
  }

  /** The simulation said something changed: maybe it stopped, maybe it is gone. */
  changed() {
    if (!this.app.objectHandle(this.id) || (!this.handle.playing && !this.app.selection.has(this.id))) {
      return this.refresh();
    }
    this.render();
  }

  render() {
    const h = this.handle;
    if (!h) return;
    this.titleEl.textContent = h.title;
    const playing = h.playing;
    this.playButton.classList.toggle("is-on", playing);
    this.playButton.querySelector("span").textContent = playing ? "Pause" : "Play";
    const icon = playing ? "pause" : "play";
    if (this.playButton.dataset.icon !== icon) {
      this.playButton.dataset.icon = icon;
      this.playButton.querySelector("svg, i")?.replaceWith(Object.assign(document.createElement("i"), {}));
      this.playButton.querySelector("i")?.setAttribute("data-lucide", icon);
      createIcons({ icons, root: this.playButton });
    }
    this.timeEl.textContent = `t = ${h.t.toFixed(2)} s`;
    const s = h.settings;
    this.speed.value = String(s.speed ?? 1);
    this.dt.value = String(s.dt ?? 0.002);
    this.window.value = String(s.window ?? 10);
    this.editButton.classList.toggle("is-on", h.editing);
    this.dockButton.classList.toggle("is-on", !!this.app.graphsPanel?.has(this.id));
    this.configsButton.classList.toggle("is-on", !!h.comparing);
    this.configsButton.title = h.comparing
      ? `Comparing with “${h.comparing}” — dashed on the graphs`
      : "Save the inputs under a name, switch between them, compare two";
  }
}
