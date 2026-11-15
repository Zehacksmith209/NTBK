import { withinHops } from "./knowledge.js";
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

export class FullGraphView {
  constructor(app) {
    this.app = app;
    this.root = null;
    this.cy = null;
    this.depth = 0;          // 0 means "everything"
    this.prereqOnly = false;
    this._onTheme = null;
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
    // Two rows rather than one: at panel width a single bar with a title,
    // four depth buttons and two actions collapses into unreadable slivers.
    this.root.innerHTML = `
      <div class="ntbk-fullgraph-bar">
        <strong>Knowledge graph</strong>
        <button class="ntbk-graph-x" data-close title="Close the graph">×</button>
      </div>
      <div class="ntbk-fullgraph-tools">
        <span class="ntbk-fullgraph-depth">
          <label>Show</label>
          <button data-depth="1">1</button>
          <button data-depth="2">2</button>
          <button data-depth="3">3</button>
          <button data-depth="0" class="is-active">all</button>
        </span>
        <button class="ntbk-mini" data-prereq title="Show only what leads into what, as a hierarchy">Needs-first view</button>
        <button class="ntbk-mini" data-relayout>Re-run layout</button>
      </div>
      <div class="ntbk-fullgraph-canvas"></div>
      <div class="ntbk-fullgraph-loading">Loading graph…</div>
      <div class="ntbk-fullgraph-hint">drag to move · double-click to centre</div>`;
    (document.querySelector("#canvas-area") ?? document.body).appendChild(this.root);

    this.root.querySelector("[data-close]").addEventListener("click", () => this.close());
    this.root.querySelector("[data-relayout]").addEventListener("click", () => this.relayout());
    this.root.querySelector("[data-prereq]").addEventListener("click", (e) => {
      this.prereqOnly = !this.prereqOnly;
      e.currentTarget.classList.toggle("is-active", this.prereqOnly);
      this.applyPrereqView();
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
    this._onKey = (event) => { if (event.key === "Escape") this.close(); };
    document.addEventListener("keydown", this._onKey);

    await this.build();
  }

  async build() {
    const cy = await load();
    const graph = this.app.knowledge;
    this.root.querySelector(".ntbk-fullgraph-loading")?.remove();

    this.groups = [...new Set(graph.graph.nodes.map((n) => n.group || ""))];

    const nodes = graph.graph.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.label,
        group: node.group || "",
        // Size carries information rather than decoration: a concept covered
        // in six places is a bigger part of the course than one noted once.
        size: sizeForAnchors(graph.anchorsOf(node.id).length),
        hasNote: node.note ? "yes" : "no",
      },
      position: (node.x != null && node.y != null) ? { x: node.x, y: node.y } : undefined,
    }));

    const edges = graph.graph.edges.map((edge) => ({
      data: { id: edge.id, source: edge.from, target: edge.to, type: edge.type },
    }));

    this.cy = cy({
      container: this.root.querySelector(".ntbk-fullgraph-canvas"),
      elements: { nodes, edges },
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
      const node = this.app.knowledge.node(n.id());
      return !node || node.x == null || node.y == null;
    });
    if (unplaced.length) this.runLayout();
    else this.cy.fit(undefined, 60);

    this.cy.on("dragfree", "node", (event) => {
      const p = event.target.position();
      this.app.knowledge.setPosition(event.target.id(), p.x, p.y);
    });

    // Hover, dim/lit focus, double-tap centring and the post-layout zoom
    // clamp all come from the shared style module. Selection is routed
    // through the app so the docked panel and the canvas overlay follow.
    this.interactions = wireInteractions(this.cy, {
      onFocus: (node) => {
        this.app.knowledge.select(node ? node.id() : null);
        this.mark();
        this.applyDepth();
      },
    });

    // The style array is built from computed CSS values, so it has to be
    // rebuilt when the theme flips — otherwise a dark graph keeps light ink.
    this._onTheme = () => this.cy?.style(graphStyle(this.groups));
    this._themeWatch = new MutationObserver(this._onTheme);
    this._themeWatch.observe(document.documentElement,
      { attributes: true, attributeFilter: ["data-theme"] });

    // Right-click a concept or a link to write a note on it. Nodes' notes
    // feed the search index, so a student's own words about why something
    // matters become a way to find it again — which is usually better than
    // anything actually written on the page.
    this.cy.on("cxttap", "node, edge", (event) => {
      event.originalEvent?.preventDefault();
      this.openNote(event.target, event.renderedPosition ?? event.position);
    });
    this.root.querySelector(".ntbk-fullgraph-canvas")
      .addEventListener("contextmenu", (e) => e.preventDefault());

    this.mark();
    this.applyDepth();

    // Cytoscape measures its container when it is created, and the canvas
    // beside it has only just been narrowed — both need a frame before the
    // sizes they read are the real ones.
    requestAnimationFrame(() => {
      this.cy?.resize();
      this.cy?.fit(undefined, 50);
      window.dispatchEvent(new Event("resize"));
    });
  }

  runLayout() {
    const layout = this.prereqOnly
      ? prerequisiteLayout()
      : layoutFor(this.cy.nodes(":visible").length);
    this.cy.layout(layout).run();
    this.persist();
  }

  relayout() {
    if (!this.cy) return;
    this.runLayout();
  }

  /**
   * Hide everything that is not a prerequisite relationship, and lay the rest
   * out as a hierarchy.
   *
   * A directed tree answers "what do I need first?" in a way a force-directed
   * blob never does — the question is about order, and only a layout with a
   * direction can show order.
   */
  applyPrereqView() {
    if (!this.cy) return;
    if (this.prereqOnly) {
      this.cy.edges().forEach((e) => {
        if (e.data("type") !== "prerequisite") e.style("display", "none");
      });
      // Concepts with no prerequisite relationship at all would float as
      // orphans in a hierarchy, so they step out of this view.
      this.cy.nodes().forEach((n) => {
        const has = n.connectedEdges().some((e) => e.data("type") === "prerequisite");
        n.style("display", has ? "element" : "none");
      });
      this.cy.layout(prerequisiteLayout()).run();
    } else {
      this.cy.elements().style("display", "element");
      this.cy.fit(undefined, 60);
    }
  }

  /** One undo entry for a whole layout, not one per node. */
  persist() {
    const write = () => this.app.knowledge.setPositions(
      this.cy.nodes().map((n) => ({ id: n.id(), ...n.position() })));
    // Animated layouts have not finished moving when run() returns
    if (reducedMotion()) write();
    else this.cy.one("layoutstop", write);
  }

  mark() {
    const selected = this.app.knowledge.selectedNodeId;
    this.cy.nodes().unselect();
    if (selected) this.cy.getElementById(selected)?.select();
  }

  /**
   * Depth-limited focus.
   *
   * At any real size this matters more than panning: it is what turns a
   * hairball into something a person can read. Shares the dim/lit classes
   * with the tap-to-focus above rather than running a second, competing
   * dimming system.
   */
  applyDepth() {
    if (!this.cy) return;
    const selected = this.app.knowledge.selectedNodeId;
    this.cy.elements().removeClass("dim lit");
    if (!selected) return;
    // "all" still focuses one hop on tap, which is what the draft's
    // closedNeighborhood() did; the buttons just widen the radius.
    const hops = this.depth || 1;
    const keep = withinHops(this.app.knowledge.graph, selected, hops);
    this.cy.nodes().forEach((n) =>
      n.addClass(keep.has(n.id()) ? "lit" : "dim"));
    this.cy.edges().forEach((e) =>
      e.addClass(keep.has(e.source().id()) && keep.has(e.target().id()) ? "lit" : "dim"));
  }

  /** A small note editor, anchored to whatever was right-clicked. */
  openNote(element, at) {
    this.closeNote();
    const id = element.id();
    const isNode = element.isNode();
    const label = isNode
      ? element.data("label")
      : `${this.app.knowledge.node(element.source().id())?.label ?? "?"}`
        + ` → ${this.app.knowledge.node(element.target().id())?.label ?? "?"}`;

    const box = document.createElement("div");
    box.className = "ntbk-graph-note";
    box.innerHTML = `<div class="ntbk-graph-note-head"></div>`;
    box.querySelector(".ntbk-graph-note-head").textContent = label;

    const area = document.createElement("textarea");
    area.placeholder = isNode
      ? "Why does this matter? What trips you up?"
      : "Why does one need the other?";
    area.value = this.app.knowledge.noteOf(id);
    area.spellcheck = false;
    box.appendChild(area);

    const foot = document.createElement("div");
    foot.className = "ntbk-graph-note-foot";
    const hint = document.createElement("span");
    hint.textContent = isNode ? "searchable" : "";
    // Delete lives here because this is where you right-clicked the thing.
    // Making people find the panel to remove a concept they are looking at
    // is the kind of detour that makes a feature feel unfinished.
    const remove = document.createElement("button");
    remove.className = "ntbk-mini ntbk-graph-note-del";
    remove.textContent = isNode ? "Delete concept" : "Unlink";
    remove.title = isNode
      ? "Delete this concept and all its regions"
      : "Remove this link, leaving both concepts";
    remove.addEventListener("click", () => {
      if (isNode) {
        const places = this.app.knowledge.anchorsOf(id).length;
        if (places && !window.confirm(
          `Delete “${label}” and its ${places} region${places === 1 ? "" : "s"}?`)) return;
        this.app.knowledge.removeNode(id);
      } else {
        this.app.knowledge.unlink(id);
      }
      this.closeNote();
      this.rebuild();
    });

    const save = document.createElement("button");
    save.className = "ntbk-mini";
    save.textContent = "Save";
    save.addEventListener("click", () => {
      this.app.knowledge.setNote(id, area.value.trim());
      this.closeNote();
      this.rebuild();
    });
    foot.appendChild(hint);
    foot.appendChild(remove);
    foot.appendChild(save);
    box.appendChild(foot);

    // Positioned inside the graph panel, in its coordinates
    const host = this.root.querySelector(".ntbk-fullgraph-canvas");
    const rect = host.getBoundingClientRect();
    box.style.left = `${Math.min(Math.max(6, at?.x ?? 20), rect.width - 216)}px`;
    box.style.top = `${Math.min(Math.max(6, at?.y ?? 20), rect.height - 140)}px`;
    host.appendChild(box);
    this.note = box;
    area.focus();

    area.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") this.closeNote();
      // Enter saves; Shift+Enter is a new line, because a note is prose
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); save.click(); }
    });
    this._noteAway = (event) => { if (this.note && !this.note.contains(event.target)) this.closeNote(); };
    setTimeout(() => document.addEventListener("pointerdown", this._noteAway, true), 0);
  }

  /**
   * Redraw after the graph itself changed.
   *
   * Cytoscape holds its own copy of the elements, so removing a concept in
   * the store leaves a ghost on screen until the view is rebuilt. Positions
   * are already persisted, so nothing is lost by tearing it down.
   */
  async rebuild() {
    if (!this.root) return;
    const depth = this.depth, prereq = this.prereqOnly;
    this._themeWatch?.disconnect();
    this.cy?.destroy();
    this.cy = null;
    await this.build();
    this.depth = depth;
    this.prereqOnly = prereq;
    if (prereq) this.applyPrereqView();
    this.applyDepth();
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
    // Give the canvas back its width
    window.dispatchEvent(new Event("resize"));
  }
}
