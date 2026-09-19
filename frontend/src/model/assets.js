import { newId } from "./ids.js";

// ─────────────────────────────────────────────
//  ASSET STORE
//
//  Binary payloads — images now, PDFs, GIFs,
//  video, audio and stickers next — live here,
//  never in the document JSON. The document
//  only ever holds an asset id.
//
//  Keeping bytes out of the model is what lets
//  a .ntbk stay a zip of one readable JSON file
//  plus plain files you could unzip and browse.
// ─────────────────────────────────────────────
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/webm": "weba",
};

export function extensionFor(mime) {
  return EXTENSIONS[mime] ?? "bin";
}

export class AssetStore {
  constructor() {
    this.items = new Map();   // id -> { id, path, mime, bytes, url }
  }

  /** Take ownership of some bytes and hand back an id to reference them by. */
  add(bytes, mime) {
    const id = newId("a");
    const path = `assets/${id}.${extensionFor(mime)}`;
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const item = { id, path, mime, bytes, url };
    this.items.set(id, item);
    return item;
  }

  get(id) {
    return this.items.get(id) ?? null;
  }

  urlFor(id) {
    return this.items.get(id)?.url ?? null;
  }

  /** The `assets` array that goes into document.json. */
  manifest() {
    return [...this.items.values()].map(({ id, path, mime, bytes }) => ({
      id, path, mime, bytes: bytes.byteLength,
    }));
  }

  /** Files to write into the zip alongside document.json. */
  files() {
    return [...this.items.values()].map(({ path, bytes }) => ({ path, bytes }));
  }

  /** Rebuild from an opened file: manifest entries plus their bytes. */
  load(manifest = [], files = new Map()) {
    this.clear();
    for (const entry of manifest) {
      const bytes = files.get(entry.path);
      if (!bytes) continue;   // a missing asset shouldn't stop the file opening
      const url = URL.createObjectURL(new Blob([bytes], { type: entry.mime }));
      this.items.set(entry.id, { ...entry, bytes, url });
    }
  }

  clear() {
    for (const item of this.items.values()) URL.revokeObjectURL(item.url);
    this.items.clear();
  }
}

/** Read a File or Blob as bytes. */
export async function readFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}
