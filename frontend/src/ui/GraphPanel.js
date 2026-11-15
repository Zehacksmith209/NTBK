import { createIcons, icons } from "lucide";

// ─────────────────────────────────────────────
//  GRAPH PANEL
//
//  Docked, ~240px wide. Deliberately NOT a
//  rendering of the graph: a force layout is
//  unreadable past about ten nodes at this
//  width, and a student who keeps this up will
//  have hundreds.
//
//  So the dock answers "where have I covered
//  this?" — search, results, and the immediate
//  surroundings of one concept as a list. The
//  picture lives in the full view.
// ─────────────────────────────────────────────

export class GraphPanel {
  constructor(app, root) {
    this.app = app;
    this.graph = app.knowledge;
    this.root = root;
    this.collapsed = true;
    this.query = "";

    root.className = "ntbk-graph-panel is-collapsed";
    root.innerHTML = `
      <div class="ntbk-panel-head ntbk-graph-head">
        <button class="ntbk-graph-fold" title="Show the knowledge graph">
          <i data-lucide="chevron-right"></i><strong>Graph</strong>
        </button>
        <span class="ntbk-graph-count"></span>
      </div>
      <div class="ntbk-graph-body">
        <div class="ntbk-panel-filter">
          <input class="ntbk-graph-search" type="text" placeholder="Search concepts" spellcheck="false">
        </div>
        <div class="ntbk-graph-results"></div>
        <div class="ntbk-graph-detail"></div>
        <button class="ntbk-mini ntbk-graph-open">Open full graph</button>
      </div>`;

    this.fold = root.querySelector(".ntbk-graph-fold");
    this.count = root.querySelector(".ntbk-graph-count");
    this.search = root.querySelector(".ntbk-graph-search");
    this.results = root.querySelector(".ntbk-graph-results");
    this.detail = root.querySelector(".ntbk-graph-detail");

    this.fold.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    this.search.addEventListener("input", () => { this.query = this.search.value; this.renderResults(); });
    this.search.addEventListener("keydown", (event) => {
      event.stopPropagation();            // never let typing reach the canvas
      if (event.key === "Escape") { this.search.value = ""; this.query = ""; this.renderResults(); }
    });
    root.querySelector(".ntbk-graph-open")
      .addEventListener("click", () => this.app.openFullGraph?.());

    this.graph.subscribe(() => this.render());
    this.render();
    queueMicrotask(() => createIcons({ icons, root }));
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.root.classList.toggle("is-collapsed", collapsed);
    this.fold.querySelector("i, svg")?.replaceWith(Object.assign(
      document.createElement("i"),
      { }, ));
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", collapsed ? "chevron-right" : "chevron-down");
    this.fold.prepend(icon);
    createIcons({ icons, root: this.fold });
    // The canvas overlays exist only while this is open, and must leave no
    // trace when it is shut — they are not part of the document.
    this.graph.panelOpen = !collapsed;
    this.app.refreshGraphOverlay?.();
    if (!collapsed) this.search.focus();
  }

  render() {
    const n = this.graph.graph.nodes.length;
    this.count.textContent = n ? `${n}` : "";
    this.renderResults();
    this.renderDetail();
    this.app.refreshGraphOverlay?.();
  }

  renderResults() {
    const hits = this.graph.search(this.query);
    this.results.innerHTML = "";

    if (!hits.length) {
      const empty = document.createElement("div");
      empty.className = "ntbk-graph-empty";
      empty.textContent = this.graph.graph.nodes.length
        ? "Nothing matches that."
        : "Select something on the page, right-click, and choose “Add to graph”.";
      this.results.appendChild(empty);
      return;
    }

    for (const hit of hits) {
      const node = this.graph.node(hit.id);
      if (!node) continue;
      const row = document.createElement("button");
      row.className = "ntbk-graph-row";
      row.classList.toggle("is-current", this.graph.selectedNodeId === node.id);
      const places = this.graph.anchorsOf(node.id).length;
      row.innerHTML = `<span class="ntbk-graph-label"></span>`
        + `<span class="ntbk-graph-places">${places}</span>`;
      row.querySelector(".ntbk-graph-label").textContent = node.label;
      row.title = `${places} region${places === 1 ? "" : "s"} on the canvas`;
      row.addEventListener("click", () => this.graph.select(node.id));
      this.results.appendChild(row);
    }
  }

  renderDetail() {
    const id = this.graph.selectedNodeId;
    this.detail.innerHTML = "";
    const node = id && this.graph.node(id);
    if (!node) return;

    const head = document.createElement("div");
    head.className = "ntbk-graph-detail-head";
    const name = document.createElement("input");
    name.className = "ntbk-graph-name";
    name.value = node.label;
    name.addEventListener("keydown", (e) => e.stopPropagation());
    name.addEventListener("change", () => this.graph.renameNode(node.id, name.value));
    head.appendChild(name);
    const del = document.createElement("button");
    del.className = "ntbk-graph-x";
    del.innerHTML = `<i data-lucide="trash-2"></i>`;
    del.title = "Delete this concept and all its regions";
    del.addEventListener("click", () => this.graph.removeNode(node.id));
    head.appendChild(del);
    this.detail.appendChild(head);

    // ── Where it appears ──
    const anchors = this.graph.anchorsOf(node.id);
    this.section("Appears in", anchors.length ? anchors.map((anchor) => {
      const page = this.app.store.data.canvas.pages.find((p) => p.id === anchor.pageId);
      const label = anchor.orphaned
        ? `page ${page ? page.index + 1 : "?"} — region emptied`
        : `page ${page ? page.index + 1 : "?"}`;
      return { label, muted: anchor.orphaned,
               go: () => this.app.goToGraphAnchor?.(anchor),
               remove: () => this.graph.removeAnchor(anchor.id) };
    }) : []);

    // ── Neighbourhood ──
    const near = this.graph.neighbourhood(node.id);
    const asRows = (list) => list.map((other) => ({
      label: other.label, go: () => this.graph.select(other.id) }));
    if (near.prerequisites.length) this.section("Needs first", asRows(near.prerequisites));
    if (near.dependents.length) this.section("Leads to", asRows(near.dependents));
    if (near.related.length) this.section("Related", asRows(near.related));

    // ── Link to another concept ──
    const others = this.graph.graph.nodes.filter((n) => n.id !== node.id);
    if (others.length) {
      const row = document.createElement("div");
      row.className = "ntbk-graph-link";
      const pick = document.createElement("select");
      // Keeps the name it had. Renaming it to "Needs first…" when the type
      // dropdown went away made it look like the LINK control had been
      // removed and the type one kept — the opposite of what happened.
      // Direction is shown where it lands: the concept you pick appears
      // under "Needs first" here, and this one under "Leads to" over there.
      pick.innerHTML = `<option value="">Link to…</option>`;
      pick.title = "The concept you pick has to come first";
      for (const other of others) {
        const option = document.createElement("option");
        option.value = other.id;
        option.textContent = other.label;
        pick.appendChild(option);
      }
      // One kind of link, so no type to choose. A second dropdown was worse
      // than useless here: the link fired on THIS control while reading the
      // type from that one, so setting the type afterwards — the natural
      // left-to-right order — silently did nothing.
      //
      // The edge still carries a type in the model, so any 'related' links
      // already in a file keep working; there is just no way to make more.
      pick.addEventListener("change", () => {
        if (!pick.value) return;
        // Directed FROM the picked concept INTO this one: the thing you chose
        // is what has to come first. That direction is the whole point — it
        // answers "what am I missing upstream?"
        this.graph.linkNodes(pick.value, node.id, "prerequisite");
        pick.value = "";
      });
      row.appendChild(pick);
      this.detail.appendChild(row);
    }

    createIcons({ icons, root: this.detail });
  }

  section(title, rows) {
    const wrap = document.createElement("div");
    wrap.className = "ntbk-graph-section";
    const head = document.createElement("div");
    head.className = "ntbk-graph-section-head";
    head.textContent = title;
    wrap.appendChild(head);
    if (!rows.length) {
      const none = document.createElement("div");
      none.className = "ntbk-graph-empty";
      none.textContent = "nowhere yet";
      wrap.appendChild(none);
    }
    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "ntbk-graph-line";
      const go = document.createElement("button");
      go.className = "ntbk-graph-go";
      go.textContent = row.label;
      go.classList.toggle("is-muted", !!row.muted);
      go.addEventListener("click", row.go);
      line.appendChild(go);
      if (row.remove) {
        const x = document.createElement("button");
        x.className = "ntbk-graph-x";
        x.textContent = "×";
        x.title = "Remove this region from the concept";
        x.addEventListener("click", row.remove);
        line.appendChild(x);
      }
      wrap.appendChild(line);
    }
    this.detail.appendChild(wrap);
  }
}
