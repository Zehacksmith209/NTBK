import { createIcons, icons } from "lucide";
import { LINK_TYPES, NODE_KINDS, linkEnds } from "../graph/knowledge.js";

/** How a link reads in the menu, from the selected concept's side. */
const PHRASES = {
  prerequisite: (o) => `needs “${o}” first`,
  derives: (o) => `is derived from “${o}”`,
  example: (o) => `is an example of “${o}”`,
  cites: (o) => `comes from “${o}”`,
  contrast: (o) => `contrasts with “${o}”`,
  related: (o) => `is related to “${o}”`,
};

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
        + `<span class="ntbk-graph-places">${node.external ? "↗" : places}</span>`;
      row.querySelector(".ntbk-graph-label").textContent = node.label;
      // The topic goes in the tooltip: at this panel's width a second column
      // leaves the names themselves unreadable
      row.title = node.external
        ? `${node.label}: in another notebook, “${node.external.title || "untitled"}”`
        : `${node.label}${node.group ? ` (${node.group})` : ""}: `
          + `${places} region${places === 1 ? "" : "s"} on the canvas`;
      row.addEventListener("click", () => this.graph.select(node.id));
      this.results.appendChild(row);
    }
  }

  renderDetail() {
    const id = this.graph.selectedNodeId;
    if (this._pendingFor !== id) { this.pending = null; this._pendingFor = id; }
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

    if (node.external) {
      this.renderExternal(node);
    } else {
      this.renderProperties(node);

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
    }

    // ── How it connects, one section per kind of link ──
    for (const section of this.graph.neighbourhood(node.id)) {
      this.section(section.heading, section.items.map(({ node: other, edge }) => ({
        label: other.external ? `${other.label} ↗` : other.label,
        go: () => this.graph.select(other.id),
        remove: () => this.graph.unlink(edge.id),
        removeTitle: "Remove this link",
      })));
    }

    if (!node.external) {
      this.renderSuggestions(node);
      this.renderLinker(node);
    }
    createIcons({ icons, root: this.detail });
  }

  /** Kind, topic, and for a reference, where it can be found. */
  renderProperties(node) {
    const box = document.createElement("div");
    box.className = "ntbk-graph-props";

    const kind = document.createElement("select");
    kind.title = "What this is";
    for (const [value, { label }] of Object.entries(NODE_KINDS)) {
      kind.add(new Option(label, value, false, (node.kind ?? "concept") === value));
    }
    kind.addEventListener("change", () => this.graph.setKind(node.id, kind.value));

    const topic = document.createElement("input");
    topic.type = "text";
    topic.placeholder = "Topic, e.g. Mechanics / Dynamics";
    topic.title = "Concepts in one topic are grouped together in the full graph. "
      + "Use / for a topic inside a topic.";
    topic.value = node.group ?? "";
    topic.spellcheck = false;
    topic.setAttribute("list", "ntbk-graph-topics");
    const topics = document.createElement("datalist");
    topics.id = "ntbk-graph-topics";
    for (const t of this.graph.topics()) topics.appendChild(new Option(t, t));
    topic.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") topic.blur();
    });
    topic.addEventListener("change", () => this.graph.setGroup(node.id, topic.value));
    box.append(kind, topic, topics);

    if ((node.kind ?? "concept") === "reference") {
      const source = document.createElement("input");
      source.type = "text";
      source.placeholder = "Link or citation";
      source.value = node.source ?? "";
      source.spellcheck = false;
      source.className = "is-wide";
      source.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") source.blur();
      });
      source.addEventListener("change", () => this.graph.setSource(node.id, source.value));
      box.appendChild(source);
      if (/^https?:\/\//i.test(node.source ?? "")) {
        const open = document.createElement("button");
        open.className = "ntbk-mini";
        open.textContent = "Open link ↗";
        open.addEventListener("click", () => this.app.openUrl?.(node.source));
        box.appendChild(open);
      }
    }
    this.detail.appendChild(box);
  }

  /** A concept that lives in another notebook: say where, and go there. */
  renderExternal(node) {
    const box = document.createElement("div");
    box.className = "ntbk-graph-props";
    const where = document.createElement("div");
    where.className = "ntbk-graph-empty";
    where.textContent = `In “${node.external.title || "another notebook"}”`
      + (node.external.path ? "" : " (not saved when it was linked)");
    const go = document.createElement("button");
    go.className = "ntbk-mini";
    go.textContent = "Go there ↗";
    go.title = node.external.path ?? "";
    go.addEventListener("click", () => this.app.openExternalConcept?.(node));
    box.append(where, go);
    this.detail.appendChild(box);
  }

  /** Links worth making, with the reason, to accept or wave away. */
  renderSuggestions(node) {
    const found = this.graph.suggestionsFor(node.id).slice(0, 5);
    if (!found.length) return;
    const wrap = document.createElement("div");
    wrap.className = "ntbk-graph-section";
    const head = document.createElement("div");
    head.className = "ntbk-graph-section-head";
    head.textContent = "Maybe linked";
    wrap.appendChild(head);
    for (const hit of found) {
      const other = this.graph.node(hit.a === node.id ? hit.b : hit.a);
      if (!other) continue;
      const line = document.createElement("div");
      line.className = "ntbk-graph-line ntbk-graph-suggest";
      const name = document.createElement("button");
      name.className = "ntbk-graph-go";
      name.textContent = other.label;
      name.title = hit.reasons.join("; ");
      name.addEventListener("click", () => this.graph.select(other.id));
      const why = document.createElement("div");
      why.className = "ntbk-graph-why";
      why.textContent = hit.reasons.join("; ");
      const link = document.createElement("button");
      link.className = "ntbk-mini";
      link.textContent = "Link…";
      link.addEventListener("click", () => { this.pending = other.id; this.renderDetail(); });
      const no = document.createElement("button");
      no.className = "ntbk-graph-x";
      no.textContent = "×";
      no.title = "Not related — stop suggesting this";
      no.addEventListener("click", () => this.graph.dismissSuggestion(hit.a, hit.b));
      line.append(name, link, no);
      wrap.append(line, why);
    }
    this.detail.appendChild(wrap);
  }

  /** Every concept this one could link to, here and in the other open notebooks. */
  linkTargets(node) {
    const here = this.graph.graph.nodes
      .filter((n) => n.id !== node.id)
      .map((n) => ({ value: n.id, label: n.external ? `${n.label} ↗` : n.label }));
    const elsewhere = [];
    const tabs = this.app.tabs?.tabs ?? [];
    for (const tab of tabs) {
      if (tab === this.app.tabs.active) continue;
      const nodes = (tab.data.graph?.nodes ?? []).filter((n) => !n.external);
      if (!nodes.length) continue;
      elsewhere.push({
        title: this.app.tabs.title(tab),
        items: nodes.map((n) => ({
          value: `ext:${tab.id}:${n.id}`, label: n.label,
          info: { notebookId: tab.data.meta?.id, nodeId: n.id, label: n.label,
                  title: this.app.tabs.title(tab), path: tab.path },
        })),
      });
    }
    return { here, elsewhere };
  }

  /**
   * Pick the other concept, then say how they are connected.
   *
   * Two steps on purpose. One control that both picked and linked used to
   * read the link type from a second control, and setting that afterwards —
   * the natural order — silently did nothing.
   */
  renderLinker(node) {
    const { here, elsewhere } = this.linkTargets(node);
    if (!here.length && !elsewhere.length) return;
    const lookup = new Map();

    const row = document.createElement("div");
    row.className = "ntbk-graph-link";
    const pick = document.createElement("select");
    pick.add(new Option("Link to…", ""));
    if (here.length) {
      const group = document.createElement("optgroup");
      group.label = "This notebook";
      for (const item of here) group.appendChild(new Option(item.label, item.value));
      pick.appendChild(group);
    }
    for (const other of elsewhere) {
      const group = document.createElement("optgroup");
      group.label = other.title;
      for (const item of other.items) {
        lookup.set(item.value, item.info);
        group.appendChild(new Option(item.label, item.value));
      }
      pick.appendChild(group);
    }
    pick.title = "Choose a concept, then how the two connect";
    row.appendChild(pick);
    this.detail.appendChild(row);

    const showChoices = (otherLabel, resolve) => {
      const choices = document.createElement("div");
      choices.className = "ntbk-graph-choices";
      const head = document.createElement("div");
      head.className = "ntbk-graph-section-head";
      head.textContent = `“${node.label}”…`;
      choices.appendChild(head);
      for (const type of Object.keys(LINK_TYPES)) {
        const button = document.createElement("button");
        button.className = "ntbk-graph-choice";
        button.textContent = PHRASES[type](otherLabel);
        button.addEventListener("click", () => {
          const otherId = resolve();
          if (!otherId) return;
          const [from, to] = linkEnds(type, node.id, otherId);
          this.graph.linkNodes(from, to, type);
          this.pending = null;
          this.renderDetail();
        });
        choices.appendChild(button);
      }
      const cancel = document.createElement("button");
      cancel.className = "ntbk-mini";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => { this.pending = null; this.renderDetail(); });
      choices.appendChild(cancel);
      this.detail.appendChild(choices);
    };

    // Coming back from "Maybe linked": the other concept is already chosen
    if (this.pending && this.graph.node(this.pending)) {
      const other = this.graph.node(this.pending);
      pick.value = other.id;
      showChoices(other.label, () => other.id);
    }

    pick.addEventListener("change", () => {
      this.detail.querySelector(".ntbk-graph-choices")?.remove();
      if (!pick.value) return;
      const info = lookup.get(pick.value);
      if (info) {
        // Another notebook's concept gets its stand-in only once a link is
        // actually made, so browsing the list leaves nothing behind
        showChoices(info.label, () => this.graph.externalNode(info)?.id);
      } else {
        const other = this.graph.node(pick.value);
        showChoices(other?.label ?? "?", () => other?.id);
      }
    });
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
        x.title = row.removeTitle ?? "Remove this region from the concept";
        x.addEventListener("click", row.remove);
        line.appendChild(x);
      }
      wrap.appendChild(line);
    }
    this.detail.appendChild(wrap);
  }
}
