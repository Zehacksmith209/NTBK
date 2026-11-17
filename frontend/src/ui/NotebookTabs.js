import { createEmptyDocument, ensureLayers } from "../model/document.js";
import { bridge } from "../bridge.js";
import { closeInspector } from "./Inspector.js";
import { closeContextMenu } from "./ContextMenu.js";

// ─────────────────────────────────────────────
//  NOTEBOOK TABS
//
//  Several notebooks in one window, one tab
//  each, the way a PDF reader holds several
//  files.
//
//  There is still one canvas. A tab is the set
//  of things that make a notebook itself — its
//  document, its undo history, its pictures and
//  PDFs, where you had scrolled to, and which
//  file it came from. Switching tabs puts one
//  set away and lays the next one out.
//
//  The document object itself is kept, not a
//  copy of it, so the undo history still points
//  at the right things when you come back.
// ─────────────────────────────────────────────
let nextTab = 1;

export class NotebookTabs {
  constructor(app, strip) {
    this.app = app;
    this.strip = strip;
    this.tabs = [];
    this.active = null;
    this.pathSynced = Promise.resolve();
    this._unsavedSent = "";

    // The notebook already on screen when the app starts becomes tab one
    this.active = this._make({ data: app.store.data, assets: app.assets.items });
    this.tabs.push(this.active);

    // Any change to the document on screen makes its tab unsaved. A reload is
    // a different document arriving, which is not an edit.
    app.store.subscribe((change) => {
      if (change.type === "reload" || !this.active || this.active.dirty) return;
      this.active.dirty = true;
      this.render();
    });

    this.render();
  }

  _make({ data, assets = new Map(), path = null }) {
    return {
      id: nextTab++,
      data,
      assets,
      undo: [],
      redo: [],
      view: { x: 0, y: 0, scale: 1 },
      layerId: null,
      path,
      dirty: false,
    };
  }

  title(tab) {
    return tab.data.meta?.title || "Untitled";
  }

  /** Nothing in it and never saved: an open file can take its place. */
  _isPristine(tab) {
    return !tab.path && !tab.dirty && !tab.undo.length
      && !tab.data.strokes?.length && !tab.data.objects?.length;
  }

  /** "Untitled", then "Untitled 2", so two new tabs are not two of the same name. */
  _freshTitle() {
    const taken = new Set(this.tabs.map((tab) => this.title(tab)));
    if (!taken.has("Untitled")) return "Untitled";
    let n = 2;
    while (taken.has(`Untitled ${n}`)) n++;
    return `Untitled ${n}`;
  }

  // ── Moving between tabs ─────────────────────
  /** Put the notebook on screen away into its tab. */
  _stow() {
    const tab = this.active;
    if (!tab) return;
    const { app } = this;
    tab.data = app.store.data;
    tab.undo = app.history.undoStack;
    tab.redo = app.history.redoStack;
    tab.assets = app.assets.items;
    tab.view = { ...app.scene.view };
    tab.layerId = app._activeLayerId ?? null;
  }

  /** Lay a tab's notebook out on the canvas. */
  _show(tab) {
    const { app } = this;
    // Anything open over the old notebook belongs to it. The plot editor
    // saves what it has first, while its own notebook is still the one on
    // screen to save into.
    app.graphEditor?.close();
    closeInspector();
    closeContextMenu();
    const graphWasOpen = !!app._fullGraph?.root;
    app._fullGraph?.close();

    app.setSelection([]);
    app.history.undoStack = tab.undo;
    app.history.redoStack = tab.redo;
    // Pictures before the document: the first render of an image looks its
    // picture up by id, and has to find it.
    app.assets.items = tab.assets;
    app._activeLayerId = tab.layerId;
    this.active = tab;

    // Code cells keep their terminal running while their notebook is in the
    // background; only closing the tab ends it.
    app.swapping = true;
    try {
      app.store.swapDocument(tab.data);
    } finally {
      app.swapping = false;
    }
    Object.assign(app.scene.view, tab.view);
    app.scene._applyView();
    app.scene._emitTransform();
    app.history._notify();
    app._syncTitle();
    this.pathSynced = bridge.setCurrentPath(tab.path);
    this.render();
    // The full graph follows you to the next notebook rather than vanishing
    if (graphWasOpen) app.openFullGraph();
  }

  switchTo(tab) {
    if (!tab || tab === this.active) return;
    this._stow();
    this._show(tab);
  }

  step(direction) {
    const at = this.tabs.indexOf(this.active);
    const next = this.tabs[(at + direction + this.tabs.length) % this.tabs.length];
    this.switchTo(next);
  }

  // ── Opening and closing ─────────────────────
  newTab() {
    const data = createEmptyDocument();
    data.meta.title = this._freshTitle();
    const tab = this._make({ data: ensureLayers(data) });
    this._stow();
    this.tabs.splice(this.tabs.indexOf(this.active) + 1, 0, tab);
    this._show(tab);
    return tab;
  }

  /**
   * Show a notebook that has just been read from disk.
   *
   * A file that is already open is switched to rather than opened twice:
   * two copies of one file would each save over the other.
   */
  open(data, assets, path = null) {
    const existing = path && this.tabs.find((tab) => tab.path === path);
    if (existing) {
      this.switchTo(existing);
      return { tab: existing, already: true };
    }

    const items = new Map();
    for (const entry of data.assets ?? []) {
      const bytes = assets.get(entry.path);
      if (!bytes) continue;   // a missing picture should not stop the file opening
      const url = URL.createObjectURL(new Blob([bytes], { type: entry.mime }));
      items.set(entry.id, { ...entry, bytes, url });
    }

    const tab = this._make({ data: this.app.store.prepare(data), assets: items, path });
    const reuse = this._isPristine(this.active) ? this.active : null;
    this._stow();
    if (reuse) {
      this.tabs.splice(this.tabs.indexOf(reuse), 1, tab);
      this._dispose(reuse);
    } else {
      this.tabs.splice(this.tabs.indexOf(this.active) + 1, 0, tab);
    }
    this._show(tab);
    return { tab, already: false };
  }

  close(tab = this.active) {
    if (!tab) return false;
    if (tab.dirty && !window.confirm(
      `“${this.title(tab)}” has changes that are not saved. Close it and lose them?`)) {
      return false;
    }

    const at = this.tabs.indexOf(tab);
    if (tab === this.active) {
      // The last tab is replaced by an empty notebook rather than leaving a
      // window with nothing in it
      if (this.tabs.length === 1) {
        this.tabs.splice(at, 1);
        this.active = null;
        const fresh = this._make({ data: ensureLayers(createEmptyDocument()) });
        this.tabs.push(fresh);
        this._show(fresh);
      } else {
        this.tabs.splice(at, 1);
        this.active = null;
        this._show(this.tabs[Math.min(at, this.tabs.length - 1)]);
      }
    } else {
      this.tabs.splice(at, 1);
      this.render();
    }
    this._dispose(tab);
    this._reportUnsaved();
    return true;
  }

  /** Let go of everything a closed tab was holding. */
  _dispose(tab) {
    for (const object of tab.data.objects ?? []) {
      if (object.type === "code") bridge.termClose(object.id);
    }
    const ids = [...tab.assets.keys()];
    for (const item of tab.assets.values()) URL.revokeObjectURL(item.url);
    this.app.pdf.forget?.(ids);
  }

  // ── Saving ──────────────────────────────────
  /** Called after the notebook on screen has been written to disk. */
  markSaved(path) {
    if (!this.active) return;
    if (path) this.active.path = path;
    this.active.dirty = false;
    this.render();
  }

  get unsaved() {
    return this.tabs.filter((tab) => tab.dirty);
  }

  /**
   * Tell the window which notebooks are unsaved, so closing it asks first.
   * Sent only when the list changes.
   */
  _reportUnsaved() {
    const names = this.unsaved.map((tab) => this.title(tab));
    const key = names.join("\n");
    if (key === this._unsavedSent) return;
    this._unsavedSent = key;
    bridge.setUnsaved(names);
  }

  // ── The strip ───────────────────────────────
  render() {
    const strip = this.strip;
    strip.innerHTML = "";
    strip.setAttribute("role", "tablist");

    for (const tab of this.tabs) {
      const el = document.createElement("div");
      el.className = "ntbk-tab-item";
      el.classList.toggle("is-active", tab === this.active);
      el.classList.toggle("is-dirty", tab.dirty);
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(tab === this.active));
      el.title = tab.path ?? `${this.title(tab)} (not saved yet)`;

      const name = document.createElement("span");
      name.className = "ntbk-tab-name";
      name.textContent = this.title(tab);

      const close = document.createElement("button");
      close.className = "ntbk-tab-close";
      close.title = tab.dirty ? "Unsaved changes. Close this notebook" : "Close this notebook";
      close.setAttribute("aria-label", `Close ${this.title(tab)}`);
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        this.close(tab);
      });

      el.append(name, close);
      el.addEventListener("pointerdown", (event) => {
        if (event.button === 0 && !event.target.closest(".ntbk-tab-close")) this.switchTo(tab);
      });
      // Middle-click closes, as it does in a browser
      el.addEventListener("auxclick", (event) => {
        if (event.button === 1) { event.preventDefault(); this.close(tab); }
      });
      strip.appendChild(el);
    }

    const add = document.createElement("button");
    add.className = "ntbk-tab-add";
    add.title = "New notebook in a tab (⌘T)";
    add.setAttribute("aria-label", "New notebook");
    add.textContent = "+";
    add.addEventListener("click", () => this.newTab());
    strip.appendChild(add);

    this.strip.querySelector(".is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    this._reportUnsaved();
  }
}
