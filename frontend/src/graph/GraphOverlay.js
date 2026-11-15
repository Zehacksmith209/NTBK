import { toSceneRect } from "./knowledge.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// ─────────────────────────────────────────────
//  CANVAS OVERLAY
//
//  Illuminated regions, drawn only while the
//  graph panel is open, and leaving nothing
//  behind when it closes.
//
//  Two host layers, both already in the app and
//  both with exactly the right semantics:
//
//    .ntbk-chrome  { pointer-events: none }
//        — the boxes and edge lines. Inert, so
//          they cannot interfere with drawing or
//          hit-testing, which is the whole
//          requirement.
//
//    .ntbk-overlay > * { pointer-events: auto }
//        — the cross-page stubs, which have to
//          be clickable.
//
//  The chrome layer is shared with the marquee
//  and the ruler, and clearChrome() wipes it
//  wholesale, so everything here lives inside
//  one <g> this file owns and clears itself.
// ─────────────────────────────────────────────

export class GraphOverlay {
  constructor(app) {
    this.app = app;
    this.group = null;
    this.stubHost = null;
    this._onTransform = () => this.refresh();
    app.host.addEventListener("scene:transform", this._onTransform);
    app.host.addEventListener("scene:changed", this._onTransform);
  }

  _ensure() {
    const chrome = this.app.host.querySelector(".ntbk-chrome");
    if (!chrome) return false;
    if (!this.group || !this.group.isConnected) {
      this.group = document.createElementNS(SVG_NS, "g");
      this.group.setAttribute("class", "ntbk-graph-overlay");
      chrome.appendChild(this.group);
    }
    const overlay = this.app.host.querySelector(".ntbk-overlay");
    if (overlay && (!this.stubHost || !this.stubHost.isConnected)) {
      this.stubHost = document.createElement("div");
      this.stubHost.className = "ntbk-graph-stubs";
      overlay.appendChild(this.stubHost);
    }
    return true;
  }

  clear() {
    if (this.group) this.group.innerHTML = "";
    if (this.stubHost) this.stubHost.innerHTML = "";
  }

  refresh() {
    const graph = this.app.knowledge;
    if (!graph?.panelOpen) { this.clear(); return; }
    if (!this._ensure()) return;
    this.clear();

    const pages = this.app.store.data.canvas.pages ?? [];
    const selected = graph.selectedNodeId;
    const view = this._viewportRect();

    // Every anchor's rect, with the scene coords it draws at
    const placed = [];
    for (const anchor of graph.graph.anchors) {
      const rect = toSceneRect(pages, anchor);
      if (!rect) continue;
      placed.push({ anchor, rect, mine: anchor.nodeId === selected });
    }

    for (const { anchor, rect, mine } of placed) {
      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("x", rect.x);
      box.setAttribute("y", rect.y);
      box.setAttribute("width", rect.w);
      box.setAttribute("height", rect.h);
      box.setAttribute("rx", "6");
      box.setAttribute("class", "ntbk-graph-box"
        + (mine ? " is-current" : "")
        + (anchor.orphaned ? " is-orphaned" : ""));
      box.dataset.anchor = anchor.id;
      this.group.appendChild(box);
    }

    if (selected) this._drawEdges(placed, view, pages);
  }

  /**
   * Edge lines, but only where a line can honestly be drawn.
   *
   * Two connected concepts usually live on different pages, and there is no
   * line from page 3 to page 11 that means anything. So: a real line only
   * when both regions are in the viewport together; otherwise a stub on the
   * edge of the box saying where the other one is, which is clickable.
   */
  _drawEdges(placed, view, pages) {
    const graph = this.app.knowledge;
    const selected = graph.selectedNodeId;
    const byNode = new Map();
    for (const p of placed) {
      if (!byNode.has(p.anchor.nodeId)) byNode.set(p.anchor.nodeId, []);
      byNode.get(p.anchor.nodeId).push(p);
    }
    const visible = (r) => r.x < view.x + view.w && r.x + r.w > view.x
                        && r.y < view.y + view.h && r.y + r.h > view.y;

    for (const edge of graph.graph.edges) {
      const otherId = edge.from === selected ? edge.to
                    : edge.to === selected ? edge.from : null;
      if (!otherId) continue;
      const mine = byNode.get(selected) ?? [];
      const theirs = byNode.get(otherId) ?? [];
      if (!mine.length || !theirs.length) continue;

      for (const a of mine) {
        if (!visible(a.rect)) continue;
        const together = theirs.find((b) => visible(b.rect));
        if (together) {
          const line = document.createElementNS(SVG_NS, "line");
          line.setAttribute("x1", a.rect.x + a.rect.w / 2);
          line.setAttribute("y1", a.rect.y + a.rect.h / 2);
          line.setAttribute("x2", together.rect.x + together.rect.w / 2);
          line.setAttribute("y2", together.rect.y + together.rect.h / 2);
          line.setAttribute("class", `ntbk-graph-edge is-${edge.type}`);
          this.group.appendChild(line);
        } else {
          this._stub(a, theirs[0], otherId, edge.type, pages);
        }
      }
    }
  }

  _stub(from, to, otherId, type, pages) {
    if (!this.stubHost) return;
    const node = this.app.knowledge.node(otherId);
    const page = pages.find((p) => p.id === to.anchor.pageId);
    const scale = this.app.scene.scale;
    const view = this.app.scene.view;

    const stub = document.createElement("button");
    stub.className = `ntbk-graph-stub is-${type}`;
    stub.textContent = `${type === "prerequisite" ? "↑" : "→"} ${node?.label ?? "?"}`
      + (page ? `  p${page.index + 1}` : "");
    stub.title = "Go to this concept's region";
    // Positioned in screen space, because it lives outside the scene's
    // transform — the scene scales, and a label that scaled with it would be
    // unreadable at the zoom levels where you most need it.
    stub.style.left = `${(from.rect.x + from.rect.w) * scale + view.x + 6}px`;
    stub.style.top = `${from.rect.y * scale + view.y}px`;
    stub.addEventListener("click", (event) => {
      event.stopPropagation();
      this.app.goToGraphAnchor(to.anchor);
    });
    this.stubHost.appendChild(stub);
  }

  flash(anchorId) {
    const box = this.group?.querySelector(`[data-anchor="${anchorId}"]`);
    if (!box) return;
    box.classList.remove("is-flash");
    void box.getBoundingClientRect();
    box.classList.add("is-flash");
    setTimeout(() => box.classList.remove("is-flash"), 1400);
  }

  _viewportRect() {
    const host = this.app.host.getBoundingClientRect();
    const { x, y, scale } = this.app.scene.view;
    return { x: -x / scale, y: -y / scale, w: host.width / scale, h: host.height / scale };
  }
}
