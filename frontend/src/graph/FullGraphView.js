import { withinHops, LINK_TYPES, NODE_KINDS, topicPath, linkEnds } from "./knowledge.js";
import {
  graphStyle, layoutFor, prerequisiteLayout, wireInteractions,
  sizeForAnchors, reducedMotion,
} from "./ntbk-graph-style.js";

// ─────────────────────────────────────────────
//  FULL GRAPH VIEW
//
//  A docked panel on the right of the canvas,
//  not a modal over it. #canvas-area is a flex
//  row, so adding a third child makes the canvas
//  genuinely narrower rather than covering it —
//  which is what lets you click a concept and
//  watch the page it lives on light up beside
//  the graph, instead of losing the canvas the
//  moment you want to look at the graph.
//
//  Cytoscape is loaded on FIRST OPEN, never at startup —
//  it is ~200KB gzipped with fcose, and a
//  student who never opens this view should
//  not pay for it. Same pattern as the MathJax
//  bundle in the exporter.
//
//  Ways to cut a big graph down to something
//  readable, all combinable:
//  - search: matches stay lit, the rest fades
//  - depth: only so many links from the focus
//  - explore: start from one concept and open
//    out its neighbours a click at a time
//  - filter: by kind of concept, kind of link
//  - topics: concepts boxed by their topic
// ─────────────────────────────────────────────

let cytoscape = null;

async function load() {
  if (cytoscape) return cytoscape;
  const [core, fcose, dagre] = await Promise.all([
    import("cytoscape"),
    import("cytoscape-fcose"),
    import("cytoscape-dagre"),
  ]);
  cytoscape = core.default;
  cytoscape.use(fcose.default);
  cytoscape.use(dagre.default);
  return cytoscape;
}

const TOPIC = "topic:";
const isTopic = (id) => id.startsWith(TOPIC);
const SUGGESTED = "suggest:";

export class FullGraphView {
  constructor(app) {
    this.app = app;
    this.root = null;
    this.cy = null;
    this.depth = 0;          // 0 means "everything"
    this.prereqOnly = false;
    this.byTopic = true;
    this.exploring = null;   // the set of node ids opened out so far, or null
    this.query = "";
    this.hiddenKinds = new Set();
    this.hiddenTypes = new Set();
    this.showSuggestions = false;
    this._onTheme = null;
    this._shape = "";

    // Edits made elsewhere (the docked panel, the canvas) redraw the picture.
    // Only when the STRUCTURE changed: a dragged node writes its position,
    // and rebuilding for that would snap the view back under the pointer.
    app.knowledge.subscribe(() => {
      if (!this.root || !this.cy) return;
      if (this._structure() !== this._shape) this.rebuild();
      else this.mark();
    });
  }

  /** Everything the picture is drawn from, except where nodes sit. */
  _structure() {
    const g = this.app.knowledge.graph;
    return JSON.stringify([
      g.nodes.map((n) => [n.id, n.label, n.kind, n.group, !!n.note, !!n.external,
                          this.app.knowledge.anchorsOf(n.id).length]),
      g.edges.map((e) => [e.id, e.from, e.to, e.type, !!e.note]),
      g.dismissed ?? [],
    ]);
  }

  async open() {
    if (this.root) return;
    const graph = this.app.knowledge;
    if (!graph.graph.nodes.length) {
      this.app._flash?.("Nothing in the graph yet");
      return;
    }

    this.root = document.createElement("div");
    this.root.className = "ntbk-fullgraph";
    this.root.innerHTML = `
      <div class="ntbk-fullgraph-bar">
        <strong>Knowledge graph</strong>
        <button class="ntbk-graph-x" data-close title="Close the graph">×</button>
      </div>
      <div class="ntbk-fullgraph-tools">
        <input class="ntbk-fullgraph-search" type="text" placeholder="Search the graph" spellcheck="false">
        <span class="ntbk-fullgraph-depth">
          <label>Show</label>
          <button data-depth="1" title="Only what is one link away from the chosen concept">1</button>
          <button data-depth="2">2</button>
          <button data-depth="3">3</button>
          <button data-depth="0" class="is-active">all</button>
        </span>
        <button class="ntbk-mini" data-explore title="Start from the chosen concept and open out its neighbours one click at a time">Explore</button>
        <button class="ntbk-mini is-active" data-topics title="Box concepts by topic">Topics</button>
        <button class="ntbk-mini" data-prereq title="Show only what leads into what, as a hierarchy">Needs-first</button>
        <button class="ntbk-mini" data-filter title="Hide kinds of concept or kinds of link">Filter ▾</button>
        <button class="ntbk-mini" data-suggest title="Links that might be missing, worked out from what is on the page">Suggested</button>
        <button class="ntbk-mini" data-relayout title="Arrange the whole graph again">Re-run layout</button>
      </div>
      <div class="ntbk-fullgraph-canvas"></div>
      <div class="ntbk-fullgraph-loading">Loading graph…</div>
      <div class="ntbk-fullgraph-legend"></div>
      <div class="ntbk-fullgraph-hint">drag to move · double-click to centre or to open another notebook · right-click for notes</div>`;
    (document.querySelector("#canvas-area") ?? document.body).appendChild(this.root);
    this._wireResize();

    const $ = (sel) => this.root.querySelector(sel);
    $("[data-close]").addEventListener("click", () => this.close());
    $("[data-relayout]").addEventListener("click", () => this.relayout());
    $("[data-prereq]").addEventListener("click", (e) => {
      this.prereqOnly = !this.prereqOnly;
      e.currentTarget.classList.toggle("is-active", this.prereqOnly);
      this.applyVisibility({ layout: true });
    });
    $("[data-topics]").addEventListener("click", (e) => {
      this.byTopic = !this.byTopic;
      e.currentTarget.classList.toggle("is-active", this.byTopic);
      this.rebuild();
    });
    $("[data-explore]").addEventListener("click", () => this.toggleExplore());
    $("[data-filter]").addEventListener("click", (e) => this.toggleFilter(e.currentTarget));
    $("[data-suggest]").addEventListener("click", (e) => {
      this.showSuggestions = !this.showSuggestions;
      e.currentTarget.classList.toggle("is-active", this.showSuggestions);
      this.rebuild();
    });
    const search = $(".ntbk-fullgraph-search");
    search.addEventListener("input", () => { this.query = search.value; this.applySearch(); });
    search.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { search.value = ""; this.query = ""; this.applySearch(); }
      if (event.key === "Enter") this.centreFirstMatch();
    });
    for (const button of this.root.querySelectorAll("[data-depth]")) {
      button.addEventListener("click", () => {
        this.depth = Number(button.dataset.depth);
        for (const other of this.root.querySelectorAll("[data-depth]")) {
          other.classList.toggle("is-active", other === button);
        }
        this.applyDepth();
      });
    }
    this._onKey = (event) => {
      if (event.key === "Escape" && !event.target.closest?.(".ntbk-fullgraph")) this.close();
    };
    document.addEventListener("keydown", this._onKey);

    await this.build();
  }

  /**
   * Drag the left edge to make the graph wider. Remembered between sessions:
   * how much room the graph gets is a lasting preference, not a one-off.
   */
  _wireResize() {
    let width = 340;
    try { width = Number(localStorage.getItem("ntbk-fullgraph-width")) || 340; } catch { /* private mode */ }
    const clamp = (w) => Math.round(Math.min(window.innerWidth * 0.7, Math.max(280, w)));
    this.root.style.flexBasis = `${clamp(width)}px`;

    const grip = document.createElement("div");
    grip.className = "ntbk-fullgraph-grip";
    grip.title = "Drag to make the graph wider or narrower";
    this.root.appendChild(grip);
    let start = null;
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      start = { x: event.clientX, w: this.root.getBoundingClientRect().width };
    });
    grip.addEventListener("pointermove", (event) => {
      if (!start) return;
      this.root.style.flexBasis = `${clamp(start.w + (start.x - event.clientX))}px`;
      this.cy?.resize();
    });
    const end = () => {
      if (!start) return;
      start = null;
      try { localStorage.setItem("ntbk-fullgraph-width", String(this.root.getBoundingClientRect().width | 0)); } catch { /* fine */ }
      this.cy?.resize();
      window.dispatchEvent(new Event("resize"));
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  // ── Building the picture ────────────────────
  _elements() {
    const graph = this.app.knowledge;
    const nodes = [], edges = [];
    const topics = new Set();

    for (const node of graph.graph.nodes) {
      const path = this.byTopic && !node.external ? topicPath(node.group) : [];
      path.forEach((t) => topics.add(t));
      nodes.push({
        data: {
          id: node.id,
          label: node.label,
          group: (node.group ?? "").split("/")[0].trim(),
          kind: node.external ? "external" : (node.kind ?? "concept"),
          // Size carries information rather than decoration: a concept covered
          // in six places is a bigger part of the course than one noted once.
          size: sizeForAnchors(graph.anchorsOf(node.id).length),
          hasNote: node.note ? "yes" : "no",
          ...(path.length ? { parent: TOPIC + path.at(-1) } : {}),
        },
        position: (node.x != null && node.y != null) ? { x: node.x, y: node.y } : undefined,
      });
    }

    // Topic boxes, nested: "Mechanics / Dynamics" sits inside "Mechanics"
    for (const topic of topics) {
      const path = topicPath(topic);
      const parent = path.length > 1 ? TOPIC + path.at(-2) : undefined;
      nodes.push({
        data: { id: TOPIC + topic, label: topic.split("/").pop().trim(), topic: "yes",
                ...(parent ? { parent } : {}) },
        selectable: false,
      });
    }

    for (const edge of graph.graph.edges) {
      edges.push({ data: { id: edge.id, source: edge.from, target: edge.to,
                           type: LINK_TYPES[edge.type] ? edge.type : "related",
                           label: (LINK_TYPES[edge.type] ?? LINK_TYPES.related).label } });
    }

    if (this.showSuggestions) {
      for (const hit of graph.suggestions()) {
        edges.push({ data: { id: SUGGESTED + hit.key, source: hit.a, target: hit.b,
                             type: "suggested", label: "maybe", reasons: hit.reasons.join("; ") } });
      }
    }
    return { nodes, edges };
  }

  async build() {
    const cy = await load();
    if (!this.root) return;
    const graph = this.app.knowledge;
    this.root.querySelector(".ntbk-fullgraph-loading")?.remove();

    this.groups = [...new Set(graph.graph.nodes.map((n) => (n.group ?? "").split("/")[0].trim()))];
    this._shape = this._structure();

    this.cy = cy({
      container: this.root.querySelector(".ntbk-fullgraph-canvas"),
      elements: this._elements(),
      style: graphStyle(this.groups),
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 3,
    });

    // Layout runs ONCE, and only for concepts that have never been placed.
    // A force layout is non-deterministic, so re-running it on every open
    // would reshuffle the picture and destroy the spatial memory that makes
    // a graph readable. "Re-run layout" is a button, never automatic.
    const unplaced = this.cy.nodes().filter((n) => {
      if (isTopic(n.id())) return false;
      const node = graph.node(n.id());
      return !node || node.x == null || node.y == null;
    });
    if (unplaced.length) this.runLayout();
    else if (this._viewport) this.cy.viewport(this._viewport);
    else this.cy.fit(undefined, 60);

    this.cy.on("dragfree", "node", (event) => {
      // Dragging a topic box moves everything in it
      const moved = isTopic(event.target.id())
        ? event.target.descendants().filter((n) => !isTopic(n.id()))
        : event.target;
      this.app.knowledge.setPositions(moved.map((n) => ({ id: n.id(), ...n.position() })));
    });

    // Hover, dim/lit focus, double-tap centring and the post-layout zoom
    // clamp all come from the shared style module. Selection is routed
    // through the app so the docked panel and the canvas overlay follow.
    this.interactions = wireInteractions(this.cy, {
      onFocus: (node) => {
        if (node && isTopic(node.id())) return;
        if (node && this.exploring) this.expand(node.id());
        this.app.knowledge.select(node ? node.id() : null);
        this.mark();
        this.applyDepth();
      },
    });

    // A concept from another notebook opens that notebook on double-click
    this.cy.on("dbltap", "node", (event) => {
      const node = this.app.knowledge.node(event.target.id());
      if (node?.external) this.app.openExternalConcept?.(node);
    });

    // A suggested link is answered where it is drawn
    this.cy.on("tap", "edge", (event) => {
      if (event.target.data("type") === "suggested") {
        this.openSuggestion(event.target, event.renderedPosition ?? event.position);
      }
    });

    // The style array is built from computed CSS values, so it has to be
    // rebuilt when the theme flips — otherwise a dark graph keeps light ink.
    this._onTheme = () => this.cy?.style(graphStyle(this.groups));
    this._themeWatch = new MutationObserver(this._onTheme);
    this._themeWatch.observe(document.documentElement,
      { attributes: true, attributeFilter: ["data-theme"] });

    // Right-click a concept or a link to write a note on it. Nodes' notes
    // feed the search index, so a student's own words about why something
    // matters become a way to find it again.
    this.cy.on("cxttap", "node, edge", (event) => {
      event.originalEvent?.preventDefault();
      if (isTopic(event.target.id()) || event.target.data("type") === "suggested") return;
      this.openNote(event.target, event.renderedPosition ?? event.position);
    });
    this.root.querySelector(".ntbk-fullgraph-canvas")
      .addEventListener("contextmenu", (e) => e.preventDefault());

    this.renderLegend();
    this.updateSuggestCount();
    this.mark();
    this.applyVisibility();
    this.applyDepth();
    this.applySearch();

    // Cytoscape measures its container when it is created, and the canvas
    // beside it has only just been narrowed — both need a frame before the
    // sizes they read are the real ones.
    requestAnimationFrame(() => {
      this.cy?.resize();
      if (!this._viewport) this.cy?.fit(undefined, 50);
      window.dispatchEvent(new Event("resize"));
    });
  }

  renderLegend() {
    const legend = this.root.querySelector(".ntbk-fullgraph-legend");
    legend.innerHTML = "";
    const used = new Set(this.app.knowledge.graph.edges.map((e) => e.type));
    for (const [type, info] of Object.entries(LINK_TYPES)) {
      if (!used.has(type)) continue;
      const item = document.createElement("span");
      item.className = `ntbk-legend-item is-${type}`;
      item.innerHTML = `<i></i>`;
      item.append(info.label);
      legend.appendChild(item);
    }
    legend.hidden = !legend.childElementCount;
  }

  updateSuggestCount() {
    const button = this.root?.querySelector("[data-suggest]");
    if (!button) return;
    const n = this.app.knowledge.suggestions().length;
    button.textContent = n ? `Suggested (${n})` : "Suggested";
    button.disabled = !n && !this.showSuggestions;
  }

  runLayout() {
    const visible = this.cy.nodes(":visible").filter((n) => !isTopic(n.id()));
    // Topic boxes need a layout that knows about boxes; the small-graph
    // circle layout would draw one topic straight through another
    const boxed = this.cy.nodes(":visible").some((n) => isTopic(n.id()));
    // Tighter spacing was tried, and makes fcose overlap the boxes. So was
    // animating with boxes: now and then it settles with one topic box drawn
    // over another, so with boxes it jumps straight to the answer.
    const layout = this.prereqOnly ? prerequisiteLayout()
      : boxed ? { ...layoutFor(Math.max(7, visible.length)), animate: false }
      : layoutFor(visible.length);
    const run = this.cy.elements(":visible").layout(layout);
    // One undo entry for a whole layout, not one per node. An animated
    // layout has not finished moving when run() returns; an instant one has
    // already finished before a listener added afterwards could hear it.
    if (layout.animate) run.one("layoutstop", () => this.persist());
    run.run();
    if (!layout.animate) this.persist();
  }

  relayout() {
    if (!this.cy) return;
    this._viewport = null;
    this.runLayout();
  }

  // ── Cutting it down ─────────────────────────
  /**
   * What is shown at all: filters, explore and the needs-first view, combined.
   * Depth and search only fade things; this removes them.
   */
  applyVisibility({ layout = false } = {}) {
    if (!this.cy) return;
    const cy = this.cy;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (isTopic(n.id())) return;
        let show = !this.hiddenKinds.has(n.data("kind"));
        if (this.exploring) show = show && this.exploring.has(n.id());
        if (this.prereqOnly) {
          show = show && n.connectedEdges().some((e) => e.data("type") === "prerequisite");
        }
        n.style("display", show ? "element" : "none");
      });
      cy.edges().forEach((e) => {
        let show = !this.hiddenTypes.has(e.data("type"));
        if (this.prereqOnly) show = e.data("type") === "prerequisite";
        if (!endsShown(e)) show = false;
        e.style("display", show ? "element" : "none");
      });
      // A topic box shows only while something inside it does
      const topics = cy.nodes().filter((n) => isTopic(n.id()));
      topics.forEach((t) => {
        const any = t.descendants().some((d) => !isTopic(d.id()) && d.style("display") !== "none");
        t.style("display", any ? "element" : "none");
      });
    });
    if (layout) {
      // A temporary arrangement: the hierarchy is not saved over the
      // positions the student chose
      if (this.prereqOnly) cy.elements(":visible").layout(prerequisiteLayout()).run();
      else cy.fit(cy.elements(":visible"), 60);
    }

    function endsShown(edge) {
      return edge.source().style("display") !== "none" && edge.target().style("display") !== "none";
    }
  }

  toggleExplore() {
    const button = this.root.querySelector("[data-explore]");
    if (this.exploring) {
      this.exploring = null;
      button.classList.remove("is-active");
      this.applyVisibility();
      this.cy?.fit(this.cy.elements(":visible"), 60);
      return;
    }
    const start = this.app.knowledge.selectedNodeId;
    if (!start) {
      this.app._flash?.("Click a concept first, then Explore");
      return;
    }
    this.exploring = new Set([start]);
    button.classList.add("is-active");
    this.expand(start);
  }

  /** Open out one concept's neighbours, and lay out only what was new. */
  expand(id) {
    if (!this.exploring) return;
    const before = new Set(this.exploring);
    for (const near of withinHops(this.app.knowledge.graph, id, 1)) this.exploring.add(near);
    this.applyVisibility();
    const fresh = this.cy.nodes().filter((n) => !before.has(n.id()) && this.exploring.has(n.id()));
    const unplaced = fresh.filter((n) => this.app.knowledge.node(n.id())?.x == null);
    if (unplaced.length) this.runLayout();
    this.cy.animate({ fit: { eles: this.cy.elements(":visible"), padding: 60 } },
                    { duration: reducedMotion() ? 0 : 260 });
  }

  toggleFilter(anchor) {
    const open = this.root.querySelector(".ntbk-fullgraph-filter");
    if (open) { open.remove(); return; }
    const box = document.createElement("div");
    box.className = "ntbk-fullgraph-filter";
    const section = (title, entries, hidden) => {
      const head = document.createElement("div");
      head.className = "ntbk-graph-section-head";
      head.textContent = title;
      box.appendChild(head);
      for (const [value, label] of entries) {
        const row = document.createElement("label");
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = !hidden.has(value);
        check.addEventListener("change", () => {
          if (check.checked) hidden.delete(value); else hidden.add(value);
          this.applyVisibility();
        });
        row.append(check, ` ${label}`);
        box.appendChild(row);
      }
    };
    section("Show concepts", [...Object.entries(NODE_KINDS).map(([k, v]) => [k, v.label]),
                              ["external", "From other notebooks"]], this.hiddenKinds);
    section("Show links", Object.entries(LINK_TYPES).map(([k, v]) => [k, v.label]), this.hiddenTypes);
    this.root.appendChild(box);
    const r = anchor.getBoundingClientRect(), host = this.root.getBoundingClientRect();
    box.style.top = `${r.bottom - host.top + 4}px`;
    box.style.left = `${Math.max(8, Math.min(r.left - host.left, host.width - 200))}px`;
    setTimeout(() => document.addEventListener("pointerdown", function away(event) {
      if (!box.contains(event.target) && event.target !== anchor) {
        box.remove();
        document.removeEventListener("pointerdown", away, true);
      }
    }, true), 0);
  }

  /** Matches stay lit and everything else fades, so where they sit is still visible. */
  applySearch() {
    if (!this.cy) return;
    this.cy.elements().removeClass("match");
    const q = this.query.trim();
    if (!q) { this.applyDepth(); return; }
    const hits = new Set(this.app.knowledge.search(q).map((h) => h.id));
    this.cy.batch(() => {
      this.cy.nodes().forEach((n) => {
        if (isTopic(n.id())) return;
        const hit = hits.has(n.id());
        n.toggleClass("match", hit);
        n.toggleClass("dim", !hit);
        n.removeClass("lit");
      });
      this.cy.edges().addClass("dim").removeClass("lit");
    });
  }

  centreFirstMatch() {
    const first = this.cy?.nodes(".match:visible").first();
    if (!first?.length) return;
    this.app.knowledge.select(first.id());
    this.cy.animate({ center: { eles: first }, zoom: 1.1 }, { duration: reducedMotion() ? 0 : 260 });
  }

  /** Where every concept now sits, as one undo entry. */
  persist() {
    if (!this.cy) return;
    this.app.knowledge.setPositions(
      this.cy.nodes().filter((n) => !isTopic(n.id()))
        .map((n) => ({ id: n.id(), ...n.position() })));
  }

  mark() {
    if (!this.cy) return;
    const selected = this.app.knowledge.selectedNodeId;
    this.cy.nodes().unselect();
    if (selected) this.cy.getElementById(selected)?.select();
  }

  /**
   * Depth-limited focus.
   *
   * At any real size this matters more than panning: it is what turns a
   * hairball into something a person can read.
   */
  applyDepth() {
    if (!this.cy) return;
    if (this.query.trim()) return;      // a search's fading wins while it is typed
    const selected = this.app.knowledge.selectedNodeId;
    this.cy.elements().removeClass("dim lit");
    if (!selected) return;
    const hops = this.depth || 1;
    const keep = withinHops(this.app.knowledge.graph, selected, hops);
    this.cy.nodes().forEach((n) => {
      if (isTopic(n.id())) return;
      n.addClass(keep.has(n.id()) ? "lit" : "dim");
    });
    this.cy.edges().forEach((e) =>
      e.addClass(keep.has(e.source().id()) && keep.has(e.target().id()) ? "lit" : "dim"));
  }

  // ── Small editors inside the view ───────────
  _popover(at) {
    this.closeNote();
    const box = document.createElement("div");
    box.className = "ntbk-graph-note";
    const host = this.root.querySelector(".ntbk-fullgraph-canvas");
    const rect = host.getBoundingClientRect();
    box.style.left = `${Math.min(Math.max(6, at?.x ?? 20), rect.width - 216)}px`;
    box.style.top = `${Math.min(Math.max(6, at?.y ?? 20), rect.height - 160)}px`;
    host.appendChild(box);
    this.note = box;
    this._noteAway = (event) => { if (this.note && !this.note.contains(event.target)) this.closeNote(); };
    setTimeout(() => document.addEventListener("pointerdown", this._noteAway, true), 0);
    return box;
  }

  /** A suggested link: why it was suggested, and what to do about it. */
  openSuggestion(edge, at) {
    const graph = this.app.knowledge;
    const a = graph.node(edge.source().id()), b = graph.node(edge.target().id());
    if (!a || !b) return;
    const box = this._popover(at);
    const head = document.createElement("div");
    head.className = "ntbk-graph-note-head";
    head.textContent = `${a.label} – ${b.label}`;
    const why = document.createElement("div");
    why.className = "ntbk-graph-why";
    why.textContent = edge.data("reasons");
    box.append(head, why);
    for (const type of ["prerequisite", "derives", "related"]) {
      const button = document.createElement("button");
      button.className = "ntbk-graph-choice";
      button.textContent = type === "prerequisite" ? `“${b.label}” needs “${a.label}” first`
        : type === "derives" ? `“${b.label}” is derived from “${a.label}”`
        : "Related";
      button.addEventListener("click", () => {
        const [from, to] = linkEnds(type, b.id, a.id);
        graph.linkNodes(from, to, type);
        this.closeNote();
      });
      box.appendChild(button);
    }
    const no = document.createElement("button");
    no.className = "ntbk-mini";
    no.textContent = "Not related";
    no.addEventListener("click", () => { graph.dismissSuggestion(a.id, b.id); this.closeNote(); });
    box.appendChild(no);
  }

  /** A small note editor, anchored to whatever was right-clicked. */
  openNote(element, at) {
    const id = element.id();
    const isNode = element.isNode();
    const graph = this.app.knowledge;
    const label = isNode
      ? element.data("label")
      : `${graph.node(element.source().id())?.label ?? "?"}`
        + ` → ${graph.node(element.target().id())?.label ?? "?"}`;

    const box = this._popover(at);
    box.innerHTML = `<div class="ntbk-graph-note-head"></div>`;
    box.querySelector(".ntbk-graph-note-head").textContent = isNode
      ? label : `${label} (${element.data("label")})`;

    const area = document.createElement("textarea");
    area.placeholder = isNode
      ? "Why does this matter? What trips you up?"
      : "Why does one need the other?";
    area.value = graph.noteOf(id);
    area.spellcheck = false;
    box.appendChild(area);

    const foot = document.createElement("div");
    foot.className = "ntbk-graph-note-foot";
    const hint = document.createElement("span");
    hint.textContent = isNode ? "searchable" : "";
    // Delete lives here because this is where you right-clicked the thing.
    const remove = document.createElement("button");
    remove.className = "ntbk-mini ntbk-graph-note-del";
    remove.textContent = isNode ? "Delete concept" : "Unlink";
    remove.title = isNode
      ? "Delete this concept and all its regions"
      : "Remove this link, leaving both concepts";
    remove.addEventListener("click", () => {
      if (isNode) {
        const places = graph.anchorsOf(id).length;
        if (places && !window.confirm(
          `Delete “${label}” and its ${places} region${places === 1 ? "" : "s"}?`)) return;
        graph.removeNode(id);
      } else {
        graph.unlink(id);
      }
      this.closeNote();
    });

    const save = document.createElement("button");
    save.className = "ntbk-mini";
    save.textContent = "Save";
    save.addEventListener("click", () => {
      graph.setNote(id, area.value.trim());
      this.closeNote();
    });
    foot.append(hint, remove, save);
    box.appendChild(foot);
    area.focus();

    area.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") this.closeNote();
      // Enter saves; Shift+Enter is a new line, because a note is prose
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); save.click(); }
    });
  }

  /**
   * Redraw after the graph itself changed.
   *
   * Cytoscape holds its own copy of the elements, so removing a concept in
   * the store leaves a ghost on screen until the view is rebuilt. Positions
   * are already persisted, and the zoom and pan are kept, so the picture
   * does not jump.
   */
  async rebuild() {
    if (!this.root) return;
    this._viewport = this.cy ? { zoom: this.cy.zoom(), pan: { ...this.cy.pan() } } : null;
    this._themeWatch?.disconnect();
    this.closeNote();
    this.cy?.destroy();
    this.cy = null;
    await this.build();
  }

  closeNote() {
    if (this._noteAway) document.removeEventListener("pointerdown", this._noteAway, true);
    this._noteAway = null;
    this.note?.remove();
    this.note = null;
  }

  close() {
    this.closeNote();
    document.removeEventListener("keydown", this._onKey);
    this._themeWatch?.disconnect();
    this._themeWatch = null;
    this.cy?.destroy();
    this.cy = null;
    this.root?.remove();
    this.root = null;
    this._viewport = null;
    this.exploring = null;
    // Give the canvas back its width
    window.dispatchEvent(new Event("resize"));
  }
}
