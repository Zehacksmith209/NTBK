import { createIcons, icons } from "lucide";

// ─────────────────────────────────────────────
//  OBJECT PANEL
//
//  A SolidWorks-style tree of everything on the
//  canvas except freehand ink. Shapes DO appear,
//  even though they are implemented as strokes,
//  because to you they are objects.
//
//  Click selects. Double-click goes to it.
//  Hover outlines it. Everything can be hidden,
//  locked, renamed and assigned to a layer.
// ─────────────────────────────────────────────
const TYPE_ICONS = {
  latex: "sigma", image: "image", pdfpage: "file-type-2",
  graph: "chart-line", code: "code", text: "type",
  line: "minus", arrow: "move-right", rect: "square",
  ellipse: "circle", triangle: "triangle",
};

const SORTS = [
  ["page", "By page"],
  ["type", "By type"],
  ["created", "Creation order"],
];

export class ObjectPanel {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.sort = "page";
    this.filter = "";
    this.collapsed = true;

    // Derived from the flag, never set independently — the two drifting apart
    // is how a panel ends up marked open while still looking shut
    root.className = `ntbk-panel${this.collapsed ? " is-collapsed" : ""}`;
    root.innerHTML = `
      <button class="ntbk-panel-toggle" title="Show the object tree">
        <i data-lucide="panel-left"></i>
      </button>
      <div class="ntbk-panel-body">
        <div class="ntbk-panel-head">
          <strong>Objects</strong>
          <select class="ntbk-panel-sort" title="How to group the tree"></select>
        </div>
        <div class="ntbk-panel-filter">
          <i data-lucide="filter"></i>
          <input type="text" placeholder="Filter by name or type" spellcheck="false">
        </div>
        <div class="ntbk-panel-tree"></div>
        <div class="ntbk-panel-layers">
          <div class="ntbk-panel-head">
            <strong>Layers</strong>
            <button class="ntbk-mini" data-add-layer>+ Layer</button>
          </div>
          <div class="ntbk-layer-list"></div>
        </div>
      </div>`;

    this.toggle = root.querySelector(".ntbk-panel-toggle");
    this.tree = root.querySelector(".ntbk-panel-tree");
    this.layerList = root.querySelector(".ntbk-layer-list");
    const sortSelect = root.querySelector(".ntbk-panel-sort");
    for (const [value, label] of SORTS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sortSelect.appendChild(option);
    }
    sortSelect.value = this.sort;
    sortSelect.addEventListener("change", () => {
      this.sort = sortSelect.value;
      this.render();
    });

    const filterInput = root.querySelector(".ntbk-panel-filter input");
    filterInput.addEventListener("input", () => {
      this.filter = filterInput.value.trim().toLowerCase();
      this.render();
    });

    this.toggle.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    root.querySelector("[data-add-layer]").addEventListener("click", () => this.app.addLayer());

    app.store.subscribe(() => this.render());
    app.host.addEventListener("scene:changed", () => this.render());
    this.render();
    queueMicrotask(() => createIcons({ icons, root }));
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.root.classList.toggle("is-collapsed", collapsed);
    // render() skips work while hidden, so opening has to ask for one
    if (!collapsed) this.render();
    // The canvas shares the row, so its size changed
    window.dispatchEvent(new Event("resize"));
    this.app.host.dispatchEvent(new CustomEvent("scene:transform"));
  }

  /**
   * Everything the tree shows: objects, shapes, and placed custom shapes —
   * never raw freehand ink.
   *
   * A custom shape is many strokes but ONE thing to you, so its pieces
   * collapse into a single row. Every entry therefore carries `ids`, not one
   * id, and every action below acts on the whole set.
   */
  entries() {
    const list = this.app.store.objects.map((o) => ({
      id: o.id, ids: [o.id], element: o, kind: o.type,
      name: o.name ?? this.app.autoName(o),
    }));

    const groups = new Map();
    for (const stroke of this.app.store.strokes) {
      if (stroke.groupId) {
        if (!groups.has(stroke.groupId)) groups.set(stroke.groupId, []);
        groups.get(stroke.groupId).push(stroke);
        continue;
      }
      // A lone drawn shape is listed on its own; plain ink never is
      if (stroke.kind === "shape") {
        list.push({
          id: stroke.id, ids: [stroke.id], element: stroke,
          kind: stroke.shape ?? "shape",
          name: stroke.name
            ?? `${(stroke.shape ?? "Shape").replace(/^./, (c) => c.toUpperCase())}`,
        });
      }
    }

    for (const members of groups.values()) {
      const first = members[0];
      list.push({
        id: first.id,
        ids: members.map((m) => m.id),
        element: first,
        kind: "custom",
        name: first.name ?? "Shape",
        parts: members.length,
      });
    }

    if (!this.filter) return list;
    return list.filter((e) =>
      e.name.toLowerCase().includes(this.filter)
      || e.kind.toLowerCase().includes(this.filter));
  }

  groups() {
    const list = this.entries();
    if (this.sort === "created") return [["All", list]];

    if (this.sort === "type") {
      const byType = new Map();
      for (const entry of list) {
        if (!byType.has(entry.kind)) byType.set(entry.kind, []);
        byType.get(entry.kind).push(entry);
      }
      return [...byType.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([kind, items]) => [kind.replace(/^./, (c) => c.toUpperCase()), items]);
    }

    // By page: worked out from position, because the stored page field was
    // never maintained and would lie
    const pages = this.app.store.data.canvas.pages ?? [];
    const byPage = new Map(pages.map((p) => [p.id, []]));
    const loose = [];
    for (const entry of list) {
      const page = this.app.pageContaining(entry.element);
      if (page) byPage.get(page.id)?.push(entry);
      else loose.push(entry);
    }
    const out = pages
      .filter((p) => byPage.get(p.id)?.length)
      .map((p) => [`Page ${p.index + 1}`, byPage.get(p.id)]);
    if (loose.length) out.push(["Off-page", loose]);
    return out;
  }

  render() {
    if (this.collapsed) return;      // nothing to draw while hidden
    this.tree.innerHTML = "";

    const groups = this.groups();
    if (!groups.some(([, items]) => items.length)) {
      const empty = document.createElement("div");
      empty.className = "ntbk-panel-empty";
      empty.textContent = this.filter
        ? "Nothing matches that filter"
        : "Nothing here yet. Freehand ink is not listed.";
      this.tree.appendChild(empty);
    }

    for (const [label, items] of groups) {
      if (!items.length) continue;
      const header = document.createElement("div");
      header.className = "ntbk-tree-group";
      header.innerHTML = `<span>${label}</span><span class="ntbk-tree-count">${items.length}</span>`;
      this.tree.appendChild(header);
      for (const entry of items) this.tree.appendChild(this.row(entry));
    }

    this.renderLayers();
    queueMicrotask(() => createIcons({ icons, root: this.tree }));
  }

  /** The canvas selection changed: restamp the rows, don't rebuild the tree. */
  markSelection() {
    if (this.collapsed) return;
    for (const row of this.tree.querySelectorAll(".ntbk-tree-row")) {
      const ids = (row.dataset.ids ?? row.dataset.id ?? "").split(" ");
      row.classList.toggle("is-selected", ids.some((id) => this.app.selection.has(id)));
    }
  }

  row(entry) {
    const { element } = entry;
    const row = document.createElement("div");
    row.className = "ntbk-tree-row";
    row.dataset.id = entry.id;
    row.dataset.ids = entry.ids.join(" ");
    row.classList.toggle("is-selected", entry.ids.some((id) => this.app.selection.has(id)));
    row.classList.toggle("is-dim", element.visible === false || element.locked);

    row.innerHTML = `
      <i data-lucide="${TYPE_ICONS[entry.kind] ?? "box"}" class="ntbk-tree-icon"></i>
      <span class="ntbk-tree-name">${escapeHtml(entry.name)}</span>
      <button class="ntbk-tree-btn" data-eye title="Show or hide">
        <i data-lucide="${element.visible === false ? "eye-off" : "eye"}"></i></button>
      <button class="ntbk-tree-btn" data-lock title="Lock against editing">
        <i data-lucide="${element.locked ? "lock" : "lock-open"}"></i></button>`;

    const name = row.querySelector(".ntbk-tree-name");

    // Single click points at it. Double click goes to it and opens its
    // properties. A double click fires the single one first, which is
    // harmless here: selecting then travelling is the same order either way.
    row.addEventListener("click", (event) => {
      if (event.target.closest(".ntbk-tree-btn")) return;
      if (name.isContentEditable) return;
      const additive = event.shiftKey || event.metaKey;
      this.app.selectFromPanel(entry.ids, additive);
      if (!additive) this.app.locateElement(entry.ids);
    });
    row.addEventListener("dblclick", (event) => {
      if (event.target.closest(".ntbk-tree-btn")) return;
      if (name.isContentEditable) return;
      this.app.goToElement(entry.ids);
      this.app.editElement(entry.id, row);
    });
    // Right-click / two-finger click: what is this and where does it live?
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.app.selectFromPanel(entry.ids, false);
      this.app.inspectElement(entry.id, row);
    });
    row.addEventListener("pointerenter", () => this.app.highlightElement(entry.ids));
    row.addEventListener("pointerleave", () => this.app.highlightElement(null));

    // Read the live element at click time. Rows are rebuilt on every store
    // change, so a value captured at render time can already be out of date.
    row.querySelector("[data-eye]").addEventListener("click", () => {
      const live = this.app.store.find(entry.id);
      if (live) this.app.setElementFlag(entry.ids, "visible", live.visible === false);
    });
    row.querySelector("[data-lock]").addEventListener("click", () => {
      const live = this.app.store.find(entry.id);
      if (live) this.app.setElementFlag(entry.ids, "locked", !live.locked);
    });

    // Double-click the name itself to rename, rather than navigating
    name.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      name.contentEditable = "true";
      name.focus();
      document.execCommand?.("selectAll", false, null);
    });
    name.addEventListener("blur", () => {
      name.contentEditable = "false";
      const value = name.textContent.trim();
      if (value && value !== entry.name) this.app.renameElement(entry.ids, value);
      else name.textContent = entry.name;
    });
    name.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); name.blur(); }
      if (event.key === "Escape") { name.textContent = entry.name; name.blur(); }
    });

    return row;
  }

  renderLayers() {
    this.layerList.innerHTML = "";
    const layers = this.app.store.data.canvas.layers ?? [];
    const active = this.app.activeLayerId();

    // Layer 1 is the topmost, so the stored order already reads top-down
    layers.forEach((layer) => {
      const row = document.createElement("div");
      row.className = "ntbk-tree-row ntbk-layer-row";
      row.classList.toggle("is-selected", layer.id === active);
      row.innerHTML = `
        <i data-lucide="layers" class="ntbk-tree-icon"></i>
        <span class="ntbk-tree-name">${escapeHtml(layer.name)}</span>
        <button class="ntbk-tree-btn" data-eye title="Show or hide the layer">
          <i data-lucide="${layer.visible === false ? "eye-off" : "eye"}"></i></button>
        <button class="ntbk-tree-btn" data-lock title="Lock the layer">
          <i data-lucide="${layer.locked ? "lock" : "lock-open"}"></i></button>`;

      row.addEventListener("click", (event) => {
        if (event.target.closest(".ntbk-tree-btn")) return;
        this.app.setActiveLayer(layer.id);
      });
      const live = () => (this.app.store.data.canvas.layers ?? [])
        .find((l) => l.id === layer.id);
      row.querySelector("[data-eye]").addEventListener("click", () => {
        const now = live();
        if (now) this.app.setLayerFlag(layer.id, "visible", now.visible === false);
      });
      row.querySelector("[data-lock]").addEventListener("click", () => {
        const now = live();
        if (now) this.app.setLayerFlag(layer.id, "locked", !now.locked);
      });
      this.layerList.appendChild(row);
    });

    queueMicrotask(() => createIcons({ icons, root: this.layerList }));
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
