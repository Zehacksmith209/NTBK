import { newId } from "../model/ids.js";

// ─────────────────────────────────────────────
//  KNOWLEDGE GRAPH
//
//  Concepts the student names by hand, each
//  pointing at one or more regions of canvas.
//
//  Manual, not extracted. Most of what is on
//  these pages is handwriting, which carries no
//  text at all — an automatic extractor would
//  only ever see the typed minority and would
//  quietly miss the majority of the work.
// ─────────────────────────────────────────────

/** Padding around a re-derived rect, so the box does not clip its contents. */
const RECT_PAD = 10;

export function createNode(label, group = "") {
  return {
    id: newId("kn"),
    label: label.trim(),
    aliases: [],
    group,
    keywords: [],
    // A free note. Searchable, because a student's own words about why a
    // concept matters are often better search terms than anything written
    // on the page itself.
    note: "",
    createdAt: new Date().toISOString(),
    // Layout position in the full graph view. Null until a layout has run;
    // once set it is never recomputed automatically, because a force layout
    // that reshuffles on every open destroys the spatial memory that makes
    // a graph readable at all.
    x: null,
    y: null,
  };
}

/**
 * A place a concept lives.
 *
 * `rect` is PAGE-RELATIVE. Canvas-absolute coordinates detach silently the
 * first time the student inserts space above a region or drags a page, and
 * the failure is invisible until they click an anchor and land on blank paper.
 *
 * `objectIds` and `strokeIds` are what the rect can be rebuilt from. Strokes
 * matter as much as objects here: a worked example is usually pure ink, and
 * an anchor that can only track objects would be unable to follow the very
 * content this feature exists to find.
 */
export function createAnchor(nodeId, pageId, rect, objectIds = [], strokeIds = [], note = "") {
  return {
    id: newId("ka"),
    nodeId,
    pageId,
    rect: { ...rect },
    objectIds: [...objectIds],
    strokeIds: [...strokeIds],
    note,
    // Set when everything the anchor tracked has been deleted. The anchor is
    // KEPT: the student wrote it down, and silently discarding their
    // structure because the content moved is how a feature loses trust.
    orphaned: false,
  };
}

export function createEdge(from, to, type = "related") {
  return { id: newId("ke"), from, to, type, note: "" };
}

// ── Pages ───────────────────────────────────

export function pageForRect(pages, rect) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return pages.find((p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h)
      ?? pages.find((p) => rect.x < p.x + p.w && rect.x + rect.w > p.x
                        && rect.y < p.y + p.h && rect.y + rect.h > p.y)
      ?? null;
}

export const toPageRect = (page, rect) =>
  ({ x: rect.x - page.x, y: rect.y - page.y, w: rect.w, h: rect.h });

export function toSceneRect(pages, anchor) {
  const page = pages.find((p) => p.id === anchor.pageId);
  if (!page) return null;
  return { x: page.x + anchor.rect.x, y: page.y + anchor.rect.y,
           w: anchor.rect.w, h: anchor.rect.h };
}

// ── Re-derivation ───────────────────────────

function boundsOfStroke(stroke) {
  const { points, stride = 3 } = stroke;
  if (!points?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i += stride) {
    const x = points[i], y = points[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function boundsOfTracked(store, anchor) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = 0;
  for (const id of anchor.objectIds) {
    const o = store.find(id);
    if (!o) continue;
    found++;
    minX = Math.min(minX, o.x);
    minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + (o.w ?? 0));
    maxY = Math.max(maxY, o.y + (o.h ?? 0));
  }
  for (const id of anchor.strokeIds) {
    const s = store.find(id);
    if (!s) continue;
    const b = boundsOfStroke(s);
    if (!b) continue;
    found++;
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return found ? { found, minX, minY, maxX, maxY } : { found: 0 };
}

/**
 * Move anchors to follow the content they were drawn around.
 *
 * Returns a NEW graph when anything changed, or null when nothing did, so the
 * caller can skip writing an undo entry for a no-op.
 *
 * An anchor whose content has all been deleted is marked `orphaned` and keeps
 * its last known rect, rather than being removed — see createAnchor.
 */
export function rederiveAnchors(graph, store, pages, touchedIds = null) {
  const touched = touchedIds ? new Set(touchedIds) : null;
  let changed = false;

  const anchors = graph.anchors.map((anchor) => {
    if (!anchor.objectIds.length && !anchor.strokeIds.length) return anchor;
    // Skip anchors nothing relevant happened to
    if (touched && ![...anchor.objectIds, ...anchor.strokeIds].some((id) => touched.has(id))) {
      return anchor;
    }

    const b = boundsOfTracked(store, anchor);
    if (!b.found) {
      if (anchor.orphaned) return anchor;
      changed = true;
      return { ...anchor, orphaned: true };
    }

    const scene = { x: b.minX - RECT_PAD, y: b.minY - RECT_PAD,
                    w: (b.maxX - b.minX) + RECT_PAD * 2,
                    h: (b.maxY - b.minY) + RECT_PAD * 2 };
    const page = pageForRect(pages, scene);
    if (!page) return anchor;
    const rect = toPageRect(page, scene);

    const same = anchor.pageId === page.id
      && Math.abs(rect.x - anchor.rect.x) < 0.5 && Math.abs(rect.y - anchor.rect.y) < 0.5
      && Math.abs(rect.w - anchor.rect.w) < 0.5 && Math.abs(rect.h - anchor.rect.h) < 0.5
      && !anchor.orphaned;
    if (same) return anchor;

    changed = true;
    return { ...anchor, pageId: page.id, rect, orphaned: false };
  });

  return changed ? { ...graph, anchors } : null;
}

// ── Text harvesting ─────────────────────────

const stripHtml = (html) => {
  const box = document.createElement("div");
  box.innerHTML = html ?? "";
  // Inline maths is stored as an attribute, not as text, so it would be
  // invisible to a plain textContent read — and a formula is exactly the
  // kind of thing a student searches for.
  for (const node of box.querySelectorAll("[data-latex]")) {
    node.textContent = ` ${node.getAttribute("data-latex")} `;
  }
  return box.textContent.replace(/\s+/g, " ").trim();
};

/** Whatever text an object carries, if any. Handwriting carries none. */
export function textOfObject(object) {
  const p = object?.payload ?? {};
  switch (object?.type) {
    case "text": return stripHtml(p.html);
    case "latex": return (p.source ?? "").trim();
    case "code": return [p.filename, p.source].filter(Boolean).join(" ").trim();
    default: return "";
  }
}

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * The text inside one anchor's region.
 *
 * Read from objects overlapping the rect rather than only from `objectIds`,
 * so something the student typed INTO a region afterwards is searchable too.
 */
export function harvestAnchor(store, pages, anchor) {
  const scene = toSceneRect(pages, anchor);
  if (!scene) return "";
  const out = [];
  for (const object of store.objects) {
    const box = { x: object.x, y: object.y, w: object.w ?? 0, h: object.h ?? 0 };
    if (!overlaps(scene, box)) continue;
    const text = textOfObject(object);
    if (text) out.push(text);
  }
  if (anchor.note) out.push(anchor.note);
  return out.join(" ");
}

/**
 * Everything a node should be findable by.
 *
 * Built automatically and NOT persisted. Hand-entered keywords are admin a
 * student will skip, after which search returns nothing and the feature looks
 * broken. Deriving it on load also avoids the staleness that storing it would
 * reintroduce — the same trap page-relative rects exist to avoid.
 */
export function searchTextFor(graph, store, pages, node) {
  const parts = [node.label, node.note ?? "",
                 ...(node.aliases ?? []), ...(node.keywords ?? [])];
  for (const anchor of graph.anchors) {
    if (anchor.nodeId !== node.id) continue;
    parts.push(harvestAnchor(store, pages, anchor));
  }
  return parts.filter(Boolean).join(" ");
}

// ── Queries ─────────────────────────────────

export const anchorsOf = (graph, nodeId) =>
  graph.anchors.filter((a) => a.nodeId === nodeId);

/**
 * A node's immediate surroundings, split by what the edge means.
 *
 * `prerequisite` is directed, and the direction is what answers the question
 * a stuck student actually has: what am I missing upstream?
 */
export function neighbourhood(graph, nodeId) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const prerequisites = [], dependents = [], related = [];
  for (const edge of graph.edges) {
    if (edge.type === "prerequisite") {
      if (edge.to === nodeId && byId.has(edge.from)) prerequisites.push(byId.get(edge.from));
      if (edge.from === nodeId && byId.has(edge.to)) dependents.push(byId.get(edge.to));
    } else {
      if (edge.from === nodeId && byId.has(edge.to)) related.push(byId.get(edge.to));
      if (edge.to === nodeId && byId.has(edge.from)) related.push(byId.get(edge.from));
    }
  }
  return { prerequisites, dependents, related };
}

/** Nodes within `depth` hops, for the full view's focus control. */
export function withinHops(graph, nodeId, depth) {
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const edge of graph.edges) {
      if (frontier.includes(edge.from) && !seen.has(edge.to)) { seen.add(edge.to); next.push(edge.to); }
      if (frontier.includes(edge.to) && !seen.has(edge.from)) { seen.add(edge.from); next.push(edge.from); }
    }
    if (!next.length) break;
    frontier = next;
  }
  return seen;
}
