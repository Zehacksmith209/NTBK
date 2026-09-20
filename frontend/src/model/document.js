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

// ─────────────────────────────────────────────
//  LAYERS
//
//  A layer holds BOTH ink and objects, and the
//  list order is the stacking order — so a
//  stroke can sit above an image, or below one,
//  which a fixed ink/object sandwich could never
//  express.
//
//  Within one layer there are still two bands:
//  objects that you write ON (a formula, a PDF)
//  sit under the ink, and objects you work IN
//  (a code cell) sit over it. That is decided by
//  type, not by the user.
// ─────────────────────────────────────────────
export function createLayer(name) {
  return { id: newId("ly"), name, visible: true, locked: false };
}

/**
 * What a printer physically cannot reach, in millimetres.
 *
 * There is no single true figure — it varies by printer — so these are the
 * tightest values that are safe across common inkjets and lasers, chosen to
 * leave the student as much usable page as possible. The bottom is much
 * larger than the rest because that is where the paper feed grips: a
 * symmetric guide would quietly lie about the one edge that bites.
 *
 * At 96dpi a page is 794x1123px, which IS A4, so 1mm = 3.7795px exactly.
 */
export const PX_PER_MM = 96 / 25.4;
export const DEFAULT_PRINT_MARGINS_MM = { top: 4, right: 4, bottom: 10, left: 4 };

export function printMarginsOf(data) {
  return data?.canvas?.printMargins ?? DEFAULT_PRINT_MARGINS_MM;
}

export const DEFAULT_LAYER_NAME = "Layer 1";

/** Objects you work in rather than write on, so they sit above the ink. */
export const OVER_INK_TYPES = new Set(["code"]);

export function bandFor(type) {
  return OVER_INK_TYPES.has(type) ? "over" : "under";
}

export function createEmptyDocument() {
  const now = new Date().toISOString();
  return {
    format: "ntbk",
    schemaVersion: SCHEMA_VERSION,
    meta: { created: now, modified: now, app: "ntbk 0.1.0", title: "Untitled" },
    canvas: {
      mode: "infinite",
      layers: [createLayer(DEFAULT_LAYER_NAME)],
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

export function createStroke({ kind = "pen", points, style, page = "pg_01",
                               layerId = null, shape, name, groupId = null }) {
  const stroke = {
    id: newId("st"),
    kind,
    layerId,          // null means "the first layer", resolved on render
    visible: true,
    locked: false,
    z: 0,
    stride: 3, // x, y, pressure
    points,
    style,
    erase: [], // subtractive masks, never a destructive edit
    page,
  };
  // Carried only when they mean something, so a plain pen stroke stays small.
  // `groupId` is what makes several strokes read as ONE thing: a custom shape
  // placed from the library is many strokes but one object to you.
  if (shape) stroke.shape = shape;
  if (name) stroke.name = name;
  if (groupId) stroke.groupId = groupId;
  return stroke;
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

export function createObject({ type, x, y, w, h, payload, name = null,
                               layerId = null }) {
  return {
    id: newId("ob"),
    type,
    name,             // shown in the panel; auto-filled if left null
    layerId,
    band: bandFor(type),
    visible: true,
    locked: false,
    z: 0,
    x, y, w, h,
    rotation: 0,
    page: "pg_01",
    payload,
    cachedRender: null,
  };
}

// ─────────────────────────────────────────────
//  MIGRATION
//  Documents saved before layers existed have no
//  layer list and elements with no layerId, so
//  fill both in on open rather than refusing the
//  file.
// ─────────────────────────────────────────────
export function ensureLayers(data) {
  const canvas = data.canvas ?? (data.canvas = {});
  if (!Array.isArray(canvas.layers) || !canvas.layers.length) {
    canvas.layers = [createLayer(DEFAULT_LAYER_NAME)];
  }
  const first = canvas.layers[0].id;

  for (const element of [...(data.strokes ?? []), ...(data.objects ?? [])]) {
    if (!element.layerId) element.layerId = first;
    if (element.visible === undefined) element.visible = true;
    if (element.locked === undefined) element.locked = false;
    if (element.type && !element.band) element.band = bandFor(element.type);
    // "layer" used to mean the ink sandwich; it is now the band
    if (element.layer) {
      element.band = element.layer === "overlay" ? "over" : "under";
      delete element.layer;
    }
  }
  return data;
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

  setLayers(layers) {
    this.data.canvas.layers = layers;
    this.emit({ type: "layers", ids: [] });
  }

  replaceDocument(data) {
    this.data = ensureLayers(data);
    this.emit({ type: "reload", ids: [] });
  }

  toJSON() {
    return JSON.parse(JSON.stringify(this.data));
  }
}
