import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

// ─────────────────────────────────────────────
//  PYTHON BRIDGE
//
//  Python is a services layer: filesystem, and
//  later code execution and PDF export. It never
//  draws anything.
//
//  A .ntbk is a zip of document.json plus an
//  assets/ folder, so media travels with the
//  notes and the file stays inspectable.
//
//  Without pywebview (the build running in a
//  plain browser) the same calls fall back to
//  download/upload.
// ─────────────────────────────────────────────
const api = () => window.pywebview?.api ?? null;

function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;   // argument limits bite on big files
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let readyPromise = null;

export const bridge = {
  get hasPython() { return !!api(); },

  /**
   * Resolves once pywebview has injected its API, or immediately in a plain
   * browser where it never will.
   *
   * pywebview attaches window.pywebview.api AFTER the page loads, so anything
   * asking Python a question during startup gets nothing back — which is how
   * the language table ended up empty and every file type looked unsupported.
   */
  whenReady(timeoutMs = 4000) {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve) => {
      if (api()) return resolve(true);
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

      window.addEventListener("pywebviewready", () => finish(true), { once: true });
      // Belt and braces: the event may already have fired before we listened
      const poll = setInterval(() => {
        if (api()) { clearInterval(poll); finish(true); }
      }, 50);
      setTimeout(() => { clearInterval(poll); finish(!!api()); }, timeoutMs);
    });
    return readyPromise;
  },

  /**
   * @param documentJson  the plain document object
   * @param assetFiles    [{ path, bytes }] to write into the zip
   */
  async saveDocument(documentJson, assetFiles = [], suggestedName = "untitled.ntbk",
                     sources = {}) {
    const text = JSON.stringify(documentJson, null, 1);

    if (api()) {
      const encoded = {};
      for (const file of assetFiles) encoded[file.path] = toBase64(file.bytes);
      return (await api().save_ntbk(text, encoded, suggestedName, sources)) ?? null;
    }

    const entries = { "document.json": strToU8(text) };
    for (const file of assetFiles) entries[file.path] = file.bytes;

    // Media is already compressed; re-deflating it costs time and saves nothing
    const zipped = zipSync(entries, { level: 6 });
    const blob = new Blob([zipped], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = suggestedName;
    link.click();
    URL.revokeObjectURL(url);
    return suggestedName;
  },

  /** @returns {{ data, assets: Map<string, Uint8Array> }|null} */
  async openDocument() {
    if (api()) {
      const payload = await api().open_ntbk();
      if (!payload) return null;
      const parsed = JSON.parse(payload);
      const assets = new Map();
      for (const [path, b64] of Object.entries(parsed.assets ?? {})) {
        assets.set(path, fromBase64(b64));
      }
      return { data: JSON.parse(parsed.document), assets };
    }

    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".ntbk";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
        const raw = entries["document.json"];
        if (!raw) return resolve(null);

        const assets = new Map();
        for (const [path, bytes] of Object.entries(entries)) {
          if (path !== "document.json") assets.set(path, bytes);
        }
        resolve({ data: JSON.parse(strFromU8(raw)), assets });
      };
      input.click();
    });
  },

  // ── PDF rasterising, done by MuPDF on the Python side ──
  async pdfOpen(assetId, bytes) {
    return api().pdf_open(assetId, toBase64(bytes));
  },

  async pdfRender(assetId, pageNumber, widthPx) {
    const encoded = await api().pdf_render(assetId, pageNumber, widthPx);
    return encoded ? fromBase64(encoded) : null;
  },

  async pdfClose(assetId) {
    return api()?.pdf_close(assetId);
  },

  // ── Code cells ──
  /** Runs only from an explicit click. Never called when a file is opened. */
  async runCode(filename, source, stdinText = "") {
    if (!api()) {
      return { ok: false, stdout: "", stderr: "Running code needs the desktop app.",
               exitCode: null, artefacts: [] };
    }
    return api().run_code(filename, source, stdinText);
  },

  // ── Terminal: one pty per code cell ──
  async termOpen(cellId, cols, rows) { return api()?.term_open(cellId, cols, rows); },
  async termWrite(cellId, data) { return api()?.term_write(cellId, data); },
  async termRun(cellId, command) { return api()?.term_run(cellId, command); },
  async termResize(cellId, cols, rows) { return api()?.term_resize(cellId, cols, rows); },
  async termClose(cellId) { return api()?.term_close(cellId); },
  async termInterrupt(cellId, hard = false) { return api()?.term_interrupt(cellId, hard); },

  /** Long-poll. Returns { data (base64), done, alive }. */
  async termRead(cellId) {
    if (!api()) return { data: "", done: null, alive: false };
    return api().term_read(cellId);
  },

  /** Write a cell's file so the shell runs what the editor shows. */
  async saveSource(filename, source) { return api()?.save_source(filename, source); },

  async codeLanguages() {
    return api() ? api().code_languages() : {};
  },

  async revealWorkdir() {
    return api()?.reveal_workdir();
  },

  /** Native file picker when we have one, browser input otherwise. */
  async pickFiles({ accept = "image/*", multiple = false } = {}) {
    if (api()) {
      const paths = await api().pick_files(accept, multiple);
      if (!paths?.length) return [];
      const out = [];
      for (const path of paths) {
        const file = await api().read_file(path);
        if (file) out.push({ name: file.name, mime: file.mime, bytes: fromBase64(file.data) });
      }
      return out;
    }

    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.multiple = multiple;
      input.onchange = async () => {
        const files = [...(input.files ?? [])];
        resolve(await Promise.all(files.map(async (f) => ({
          name: f.name,
          mime: f.type || "application/octet-stream",
          bytes: new Uint8Array(await f.arrayBuffer()),
        }))));
      };
      input.click();
    });
  },
};
