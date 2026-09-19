import { newId } from "./ids.js";

// ─────────────────────────────────────────────
//  DOCUMENT MODEL
//
//  Plain JSON. No DOM nodes, no library objects,
//  no rendering state. This is the whole point:
//  the view layer can be rewritten without
//  invalidating anyone's saved files.
// ─────────────────────────────────────────────

export const SCHEMA_VERSION = 1;

// One coordinate space for everything: CSS pixels at 96dpi.
export const A4_PORTRAIT = { w: 794, h: 1123 };

export function createEmptyDocument() {
  const now = new Date().toISOString();
  return {
    format: "ntbk",
    schemaVersion: SCHEMA_VERSION,
    meta: { created: now, modified: now, app: "ntbk 0.1.0", title: "Untitled" },
    canvas: {
      mode: "infinite",
      background: { type: "grid", spacing: 20, color: "#e9e9ee" },
      pages: [
        { id: "pg_01", index: 0, x: 0, y: 0, w: A4_PORTRAIT.w, h: A4_PORTRAIT.h },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    strokes: [],
    objects: [],
    assets: [],
  };
}

export function createStroke({ kind = "pen", points, style, page = "pg_01" }) {
  return {
    id: newId("st"),
    kind,
    z: 0,
    stride: 3, // x, y, pressure
    points,
    style,
    erase: [], // subtractive masks, never a destructive edit
    page,
  };
}

/** A new page, stacked under the last one with a visible gutter between. */
export const PAGE_GAP = 36;

export function createPage(pages) {
  const last = pages[pages.length - 1];
  return {
    id: newId("pg"),
    index: pages.length,
    x: last ? last.x : 0,
    y: last ? last.y + last.h + PAGE_GAP : 0,
    w: last ? last.w : A4_PORTRAIT.w,
    h: last ? last.h : A4_PORTRAIT.h,
  };
}

export function createObject({ type, x, y, w, h, payload, layer = "content" }) {
  return {
    id: newId("ob"),
    type,
    layer,
    z: 0,
    x, y, w, h,
    rotation: 0,
    locked: false,
    page: "pg_01",
    payload,
    cachedRender: null,
  };
}

// ─────────────────────────────────────────────
//  STORE
//  Owns the document and tells listeners what
//  changed, so renderers can update just the
//  affected elements instead of redrawing all.
// ─────────────────────────────────────────────
export class Store {
  constructor(data) {
    this.data = data ?? createEmptyDocument();
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(change) {
    this.data.meta.modified = new Date().toISOString();
    for (const fn of this.listeners) fn(change);
  }

  // ── Lookup ────────────────────────────────
  get strokes() { return this.data.strokes; }
  get objects() { return this.data.objects; }

  find(id) {
    return this.data.strokes.find((s) => s.id === id)
        ?? this.data.objects.find((o) => o.id === id)
        ?? null;
  }

  isStroke(id) { return this.data.strokes.some((s) => s.id === id); }

  // ── Mutation ──────────────────────────────
  // Deliberately dumb: every one of these is wrapped by a command in
  // history.js, which is what makes undo possible. Nothing outside a
  // command should call these directly.
  insert(element) {
    if (element.kind) this.data.strokes.push(element);
    else this.data.objects.push(element);
    this.emit({ type: "add", ids: [element.id] });
  }

  insertMany(elements) {
    for (const el of elements) {
      if (el.kind) this.data.strokes.push(el);
      else this.data.objects.push(el);
    }
    this.emit({ type: "add", ids: elements.map((e) => e.id) });
  }

  removeMany(ids) {
    const set = new Set(ids);
    this.data.strokes = this.data.strokes.filter((s) => !set.has(s.id));
    this.data.objects = this.data.objects.filter((o) => !set.has(o.id));
    this.emit({ type: "remove", ids });
  }

  patch(id, changes) {
    const el = this.find(id);
    if (!el) return;
    Object.assign(el, changes);
    this.emit({ type: "update", ids: [id] });
  }

  patchMany(entries) {
    for (const { id, changes } of entries) {
      const el = this.find(id);
      if (el) Object.assign(el, changes);
    }
    this.emit({ type: "update", ids: entries.map((e) => e.id) });
  }

  setPages(pages) {
    this.data.canvas.pages = pages;
    this.emit({ type: "pages", ids: [] });
  }

  replaceDocument(data) {
    this.data = data;
    this.emit({ type: "reload", ids: [] });
  }

  toJSON() {
    return JSON.parse(JSON.stringify(this.data));
  }
}
