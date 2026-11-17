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

/** Wait for one bridge method to actually exist, not just the api object. */
async function waitForMethod(name, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fn = api()?.[name];
    if (typeof fn === "function") return fn.bind(api());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
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

  /** A notebook this window was launched with, if any. Handed over once. */
  async pendingOpen() {
    // Being "ready" is not the same as being callable: pywebview creates
    // window.pywebview.api first and attaches the methods a moment later, so
    // asking at startup finds the object but not the function on it.
    const method = await waitForMethod("take_pending_open");
    if (!method) return null;
    const payload = await method();
    if (!payload) return null;
    const parsed = JSON.parse(payload);
    const assets = new Map();
    for (const [path, b64] of Object.entries(parsed.assets ?? {})) {
      assets.set(path, fromBase64(b64));
    }
    return { data: JSON.parse(parsed.document), assets, path: parsed.path ?? null };
  },

  /** Open another notebook in its own window. */
  async newWindow() {
    if (!api()) return { ok: false, error: "Extra windows need the desktop app" };
    const raw = await api().new_window();
    return raw ? JSON.parse(raw) : { ok: false };
  },

  /** Name the window after its document. */
  /** Save exported text (CSV results and the like) where the user chooses. */
  async saveText(name, text, kind = "Text") {
    if (!api()) {
      // Without the desktop app, an ordinary browser download
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { ok: true, name };
    }
    try { return JSON.parse(await api().save_text_file(name, text, kind)); }
    catch (error) { return { ok: false, error: String(error) }; }
  },

  /** Open a notebook file by its path, for a link from another notebook. */
  async openPath(path) {
    if (!api() || !path) return null;
    const payload = await api().open_ntbk_path(path);
    if (!payload) return null;
    const parsed = JSON.parse(payload);
    const assets = new Map();
    for (const [name, b64] of Object.entries(parsed.assets ?? {})) {
      assets.set(name, fromBase64(b64));
    }
    return { data: JSON.parse(parsed.document), assets, path: parsed.path ?? null };
  },

  /** The file the notebook on screen saves to, or null before its first save. */
  async currentPath() {
    if (!api()) return null;
    try { return (await api().get_current_path()) || null; } catch { return null; }
  },

  /** Point saving, code cells and exports at another tab's file (null for a new one). */
  async setCurrentPath(path) {
    if (!api()) return false;
    try { return await api().set_current_path(path ?? null); } catch { return false; }
  },

  /** Which notebooks have unsaved changes, so closing the window asks first. */
  async setUnsaved(names) {
    if (!api()) return false;
    try { return await api().set_unsaved(names ?? []); } catch { return false; }
  },

  async setTitle(title) {
    if (!api()) { document.title = title ? `${title} — ntbk` : "ntbk"; return; }
    await api().set_title(title ?? "");
  },

  /** Hand rendered A4 pages to Python to be bound into a PDF. */
  async exportPdf(pages, suggestedName = "untitled.pdf", openAfter = false) {
    if (!api()) return { ok: false, error: "PDF export needs the desktop app" };
    const raw = await api().export_pdf(pages, suggestedName, openAfter);
    return raw ? JSON.parse(raw) : { ok: false };
  },

  async saveShape(name, shape) {
    if (!api()) return { ok: false, error: "Saving shapes needs the desktop app" };
    return JSON.parse(await api().save_shape(name, JSON.stringify(shape)));
  },

  async listShapes() {
    if (!api()) return [];
    try {
      return JSON.parse(await api().list_shapes()) ?? [];
    } catch {
      return [];
    }
  },

  /** The folder the library is currently read from. */
  async shapeFolder() {
    if (!api()) return "";
    try { return await api().shape_library(); } catch { return ""; }
  },

  /** Native folder picker. Returns { ok, folder } or { ok: false, cancelled }. */
  async chooseShapeFolder() {
    if (!api()) return { ok: false, error: "Needs the desktop app" };
    try { return JSON.parse(await api().choose_shape_library()); }
    catch (error) { return { ok: false, error: String(error) }; }
  },

  async resetShapeFolder() {
    if (!api()) return { ok: false };
    try { return JSON.parse(await api().reset_shape_library()); }
    catch (error) { return { ok: false, error: String(error) }; }
  },

  /** "light" or "dark", remembered in ~/.ntbk.json. */
  async getTheme() {
    if (!api()) return localStorage.getItem("ntbk-theme") || "light";
    try { return await api().get_theme(); } catch { return "light"; }
  },

  async setTheme(theme) {
    // Mirrored to localStorage so the next launch can paint the right colours
    // before the Python bridge has finished answering — otherwise dark mode
    // starts every session with a flash of white.
    try { localStorage.setItem("ntbk-theme", theme); } catch { /* private mode */ }
    if (!api()) return { ok: true, theme };
    try { return JSON.parse(await api().set_theme(theme)); }
    catch (error) { return { ok: false, error: String(error) }; }
  },

  /** { active:{x,y}, saved:{x,y} } — stylus coordinate correction. */
  async pointerOffset() {
    if (!api()) return { active: { x: 0, y: 0 }, saved: { x: 0, y: 0 } };
    try { return JSON.parse(await api().get_pointer_offset()); }
    catch { return { active: { x: 0, y: 0 }, saved: { x: 0, y: 0 } }; }
  },

  async setPointerOffset(x, y, remember = true) {
    if (!api()) return { active: { x, y }, saved: { x, y } };
    try { return JSON.parse(await api().set_pointer_offset(x, y, remember)); }
    catch { return { active: { x, y }, saved: { x, y } }; }
  },

  /**
   * The formula library, as the JSON text it is stored as.
   *
   * Empty string means "no library yet", which is different from an empty
   * one. In a plain browser there is no Python, so the same text is kept in
   * localStorage and the feature can still be worked on with `npm run dev`.
   */
  async getFormulas() {
    if (!api()) {
      try { return localStorage.getItem("ntbk-formulas") ?? ""; } catch { return ""; }
    }
    try { return (await api().get_formulas()) ?? ""; } catch { return ""; }
  },

  async saveFormulas(text) {
    if (!api()) {
      try { localStorage.setItem("ntbk-formulas", text); return { ok: true }; }
      catch (error) { return { ok: false, error: String(error) }; }
    }
    try { return JSON.parse(await api().save_formulas(text)); }
    catch (error) { return { ok: false, error: String(error) }; }
  },

  /** Hand a web address to the system browser. */
  async openUrl(url) {
    if (!api()) { window.open(url, "_blank", "noopener"); return true; }
    try { return await api().open_url(url); } catch { return false; }
  },

  // ── Companion mode ────────────────────────
  async companionStart() {
    if (!api()) return { running: false };
    try { return JSON.parse(await api().companion_start()); }
    catch (error) { return { running: false, error: String(error) }; }
  },

  async companionStop() {
    if (!api()) return { running: false };
    try { return JSON.parse(await api().companion_stop()); } catch { return { running: false }; }
  },

  async companionStatus() {
    if (!api()) return { running: false };
    try { return JSON.parse(await api().companion_status()); } catch { return { running: false }; }
  },

  async companionSetDocument(json) {
    if (!api()) return false;
    try { return await api().companion_set_document(json); } catch { return false; }
  },

  async companionBroadcast(message) {
    if (!api()) return false;
    try { return await api().companion_broadcast(JSON.stringify(message)); } catch { return false; }
  },

  async deleteShape(name) {
    if (!api()) return { ok: false };
    return JSON.parse(await api().delete_shape(name));
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
      return { data: JSON.parse(parsed.document), assets, path: parsed.path ?? null };
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
