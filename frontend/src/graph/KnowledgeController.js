import MiniSearch from "minisearch";
import { setGraph } from "../model/history.js";
import {
  createNode, createAnchor, createEdge, rederiveAnchors,
  searchTextFor, anchorsOf, neighbourhood, toSceneRect, pageForRect, toPageRect,
  LINK_TYPES, NODE_KINDS, suggestLinks, pairKey,
} from "./knowledge.js";

// ─────────────────────────────────────────────
//  THE GRAPH, AS THE APP SEES IT
//
//  Owns three things the model deliberately
//  does not: the undo entries, the search index,
//  and keeping anchors pinned to content that
//  moves underneath them.
// ─────────────────────────────────────────────

export class KnowledgeController {
  constructor(app) {
    this.app = app;
    this.index = null;
    this.selectedNodeId = null;
    this.listeners = new Set();
    // Open/closed decides whether the canvas overlays exist at all. They must
    // leave no trace when the panel is shut.
    this.panelOpen = false;

    app.store.subscribe((change) => this._onStoreChange(change));
  }

  // ── Reading ───────────────────────────────
  get graph() { return this.app.store.graph; }
  get pages() { return this.app.store.data.canvas.pages ?? []; }

  node(id) { return this.graph.nodes.find((n) => n.id === id) ?? null; }
  anchorsOf(nodeId) { return anchorsOf(this.graph, nodeId); }
  neighbourhood(nodeId) { return neighbourhood(this.graph, nodeId); }
  sceneRect(anchor) { return toSceneRect(this.pages, anchor); }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn(); }

  // ── Writing ───────────────────────────────
  /**
   * Every mutation goes through here, so one gesture is one undo step even
   * when it writes a node, an anchor and an edge at once.
   */
  _commit(mutate, label) {
    const before = structuredClone(this.graph);
    const after = structuredClone(before);
    const result = mutate(after);
    this.app.history.run(setGraph(before, after, label));
    this.index = null;          // rebuilt lazily on the next search
    this._suggested = null;
    this._emit();
    return result;
  }

  addNode(label, group = "") {
    return this._commit((g) => {
      const node = createNode(label, group);
      g.nodes.push(node);
      return node;
    }, "Add concept");
  }

  /**
   * The capture path: a region of canvas becomes a place a concept lives.
   *
   * `bounds` is canvas-absolute because that is what the selection gives us;
   * it is converted to page-relative here, which is the only form stored.
   */
  addAnchor(nodeId, bounds, { objectIds = [], strokeIds = [], note = "" } = {}) {
    const page = pageForRect(this.pages, bounds);
    if (!page) return null;
    const rect = toPageRect(page, bounds);
    return this._commit((g) => {
      const anchor = createAnchor(nodeId, page.id, rect, objectIds, strokeIds, note);
      g.anchors.push(anchor);
      return anchor;
    }, "Add to graph");
  }

  /** New concept and its first region, as ONE undo step. */
  captureAs(label, bounds, opts = {}) {
    const page = pageForRect(this.pages, bounds);
    if (!page) return null;
    const rect = toPageRect(page, bounds);
    return this._commit((g) => {
      const node = createNode(label, opts.group ?? "");
      g.nodes.push(node);
      g.anchors.push(createAnchor(node.id, page.id, rect,
        opts.objectIds ?? [], opts.strokeIds ?? [], opts.note ?? ""));
      return node;
    }, "Add to graph");
  }

  renameNode(id, label) {
    this._commit((g) => {
      const n = g.nodes.find((x) => x.id === id);
      if (n) n.label = label.trim();
    }, "Rename concept");
  }

  setAliases(id, aliases) {
    this._commit((g) => {
      const n = g.nodes.find((x) => x.id === id);
      if (n) n.aliases = aliases.map((a) => a.trim()).filter(Boolean);
    }, "Edit aliases");
  }

  setGroup(id, group) {
    this._commit((g) => {
      const n = g.nodes.find((x) => x.id === id);
      if (n) n.group = group.trim();
    }, "Set group");
  }

  setPosition(id, x, y) {
    this._commit((g) => {
      const n = g.nodes.find((x2) => x2.id === id);
      if (n) { n.x = x; n.y = y; }
    }, "Move concept");
  }

  /** Bulk position write after a layout run — one undo step, not N. */
  setPositions(entries) {
    this._commit((g) => {
      for (const { id, x, y } of entries) {
        const n = g.nodes.find((x2) => x2.id === id);
        if (n) { n.x = x; n.y = y; }
      }
    }, "Lay out graph");
  }

  /** Every topic in use, including the levels above nested ones. */
  topics() {
    const all = new Set();
    for (const node of this.graph.nodes) {
      const parts = String(node.group ?? "").split("/").map((p) => p.trim()).filter(Boolean);
      parts.forEach((_, i) => all.add(parts.slice(0, i + 1).join(" / ")));
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }

  setKind(id, kind) {
    if (!NODE_KINDS[kind]) return;
    this._commit((g) => {
      const n = g.nodes.find((x) => x.id === id);
      if (n) n.kind = kind;
    }, "Set kind");
  }

  /** Where a reference lives: a web address, or a citation as plain text. */
  setSource(id, source) {
    this._commit((g) => {
      const n = g.nodes.find((x) => x.id === id);
      if (n) n.source = String(source ?? "").trim();
    }, "Set source");
  }

  /**
   * A stand-in for a concept that lives in another notebook.
   *
   * Links can only join nodes in the same graph, so the other notebook's
   * concept gets a small local node that remembers where the real one is:
   * the notebook's id (which survives renaming the file), its path when it
   * was linked, and the concept's id there. One stand-in per real concept.
   */
  externalNode({ notebookId, nodeId, label, title, path }) {
    const existing = this.graph.nodes.find((n) =>
      n.external?.notebookId === notebookId && n.external?.nodeId === nodeId);
    if (existing) return existing;
    return this._commit((g) => {
      const node = createNode(label);
      node.external = { notebookId, nodeId, title: title ?? "", path: path ?? null };
      g.nodes.push(node);
      return node;
    }, "Add concept from another notebook");
  }

  /** Keep a stand-in's address current when its notebook is found again. */
  updateExternal(id, patch) {
    const node = this.node(id);
    if (!node?.external) return;
    const same = Object.entries(patch).every(([k, v]) => node.external[k] === v);
    if (same) return;
    this._commit((g) => {
      const n = g.nodes.find((x) => x.id === id);
      if (n?.external) Object.assign(n.external, patch);
    }, "Update link");
  }

  /** Links worth suggesting, recomputed whenever the notebook has changed. */
  suggestions() {
    if (!this._suggested) {
      this._suggested = suggestLinks(this.graph, this.app.store, this.pages);
    }
    return this._suggested;
  }

  suggestionsFor(nodeId) {
    return this.suggestions().filter((s) => s.a === nodeId || s.b === nodeId);
  }

  /** "Not related" — never suggest this pair again. */
  dismissSuggestion(a, b) {
    this._commit((g) => {
      g.dismissed = [...new Set([...(g.dismissed ?? []), pairKey(a, b)])];
    }, "Dismiss suggestion");
  }

  linkNodes(from, to, type = "related") {
    if (from === to) return null;
    const undirected = LINK_TYPES[type] && !LINK_TYPES[type].directed;
    const exists = this.graph.edges.some((e) =>
      e.type === type && ((e.from === from && e.to === to)
        || (undirected && e.from === to && e.to === from)));
    if (exists) return null;
    return this._commit((g) => {
      const edge = createEdge(from, to, type);
      g.edges.push(edge);
      return edge;
    }, "Link concepts");
  }

  unlink(edgeId) {
    this._commit((g) => { g.edges = g.edges.filter((e) => e.id !== edgeId); }, "Unlink");
  }

  /** Deleting a concept takes its anchors and edges with it. */
  removeNode(id) {
    this._commit((g) => {
      g.nodes = g.nodes.filter((n) => n.id !== id);
      g.anchors = g.anchors.filter((a) => a.nodeId !== id);
      g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
    }, "Delete concept");
    if (this.selectedNodeId === id) this.selectedNodeId = null;
  }

  removeAnchor(id) {
    this._commit((g) => { g.anchors = g.anchors.filter((a) => a.id !== id); }, "Remove region");
  }

  /**
   * Which concepts, if any, this canvas selection already belongs to.
   *
   * Matched against what each anchor TRACKS rather than against its rect:
   * a rect is a consequence of the content, and asking "is this stroke one
   * of the ones this concept was drawn around?" is the question that stays
   * true after the region has been moved or resized.
   */
  nodesForSelection(ids) {
    const wanted = new Set(ids);
    const found = new Set();
    for (const anchor of this.graph.anchors) {
      const tracked = [...anchor.objectIds, ...anchor.strokeIds];
      if (tracked.some((id) => wanted.has(id))) found.add(anchor.nodeId);
    }
    return [...found].map((id) => this.node(id)).filter(Boolean);
  }

  /** A free note on a concept or a link. Feeds search for nodes. */
  setNote(id, note) {
    this._commit((g) => {
      const node = g.nodes.find((n) => n.id === id);
      if (node) { node.note = note; return; }
      const edge = g.edges.find((e) => e.id === id);
      if (edge) edge.note = note;
    }, "Edit note");
  }

  noteOf(id) {
    return this.graph.nodes.find((n) => n.id === id)?.note
        ?? this.graph.edges.find((e) => e.id === id)?.note
        ?? "";
  }

  select(nodeId) {
    this.selectedNodeId = nodeId;
    this._emit();
  }

  // ── Keeping anchors on their content ──────
  _onStoreChange(change) {
    // Anything on the page can change what is worth suggesting
    this._suggested = null;
    if (change.type === "graph") { this.index = null; this._emit(); return; }
    if (change.type === "reload") {
      // A different notebook (opened, or another tab): its own search index,
      // and nothing selected that belonged to the last one
      this.index = null;
      if (this.selectedNodeId && !this.node(this.selectedNodeId)) this.selectedNodeId = null;
      this._emit();
    }
    if (!this.graph.anchors.length) return;

    // A reload brings a different document; re-derive everything once.
    const touched = change.type === "reload" ? null : change.ids;
    if (touched && !touched.length) return;

    const next = rederiveAnchors(this.graph, this.app.store, this.pages, touched);
    if (!next) return;
    // Deliberately NOT an undo entry. The student moved a stroke; the anchor
    // following it is a consequence, not a second thing to undo. Undoing the
    // move re-fires this and puts the anchor back.
    this.app.store.setGraph(next);
    this.index = null;
  }

  // ── Search ────────────────────────────────
  _buildIndex() {
    const index = new MiniSearch({
      fields: ["label", "text"],
      storeFields: ["label"],
      searchOptions: { boost: { label: 3 }, prefix: true, fuzzy: 0.2 },
    });
    index.addAll(this.graph.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      text: [searchTextFor(this.graph, this.app.store, this.pages, node),
             node.group ?? "", node.source ?? "", node.external?.title ?? ""].join(" "),
    })));
    this.index = index;
    return index;
  }

  search(query) {
    const q = (query ?? "").trim();
    if (!q) return this.graph.nodes.slice(0, 40).map((n) => ({ id: n.id, label: n.label }));
    const index = this.index ?? this._buildIndex();
    return index.search(q).slice(0, 40).map((r) => ({ id: r.id, label: r.label, score: r.score }));
  }
}
