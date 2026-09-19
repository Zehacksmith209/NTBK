import { bridge } from "../bridge.js";

// ─────────────────────────────────────────────
//  PDF SERVICE
//
//  Pages are rasterised by MuPDF on the Python
//  side. pdf.js was the original choice and it
//  opens documents and reads pages correctly,
//  but page.render() never settles — silently,
//  in both Chromium and WKWebView. MuPDF does
//  the same page in about 30ms.
//
//  The frontend still owns layout, placement,
//  annotation and zoom policy. Python only
//  turns a page into pixels.
//
//  Only the source PDF is saved in a .ntbk;
//  bitmaps live in memory here, so notebooks
//  stay small and a page can be re-rendered
//  sharper whenever you zoom in.
// ─────────────────────────────────────────────

// Rendered width = displayed width x this x the zoom bucket. 1.5 puts a page
// at roughly 150dpi when the canvas is at 100%.
const BASE_OVERSAMPLE = 1.5;
const MAX_WIDTH = 4000;

export class PdfService {
  constructor() {
    this.documents = new Map();  // assetId -> Promise<{pages, sizes}>
    this.renders = new Map();    // "assetId:page:width" -> Promise<blob URL>
    this.urls = [];
  }

  /** Zoom levels are bucketed so a pinch doesn't trigger a render per frame. */
  static bucketFor(scale) {
    if (scale > 3) return 4;
    if (scale > 1.5) return 2;
    return 1;
  }

  get available() {
    return bridge.hasPython;
  }

  open(assetId, bytes) {
    if (!this.documents.has(assetId)) {
      if (!bridge.hasPython) {
        return Promise.reject(new Error("PDF rendering needs the desktop app"));
      }
      this.documents.set(assetId, bridge.pdfOpen(assetId, bytes));
    }
    return this.documents.get(assetId);
  }

  async pageCount(assetId, bytes) {
    return (await this.open(assetId, bytes)).pages;
  }

  /** Page size in CSS pixels at 100%, for laying pages out before rendering. */
  async pageSize(assetId, bytes, pageNumber) {
    const info = await this.open(assetId, bytes);
    const [width, height] = info.sizes[pageNumber - 1] ?? [595, 842];
    return { width, height };
  }

  async renderPage(assetId, bytes, pageNumber, displayWidth, bucket = 1) {
    const width = Math.min(MAX_WIDTH,
      Math.round(displayWidth * BASE_OVERSAMPLE * bucket));
    const key = `${assetId}:${pageNumber}:${width}`;
    if (this.renders.has(key)) return this.renders.get(key);

    const promise = (async () => {
      await this.open(assetId, bytes);
      const png = await bridge.pdfRender(assetId, pageNumber, width);
      if (!png) throw new Error(`No output for page ${pageNumber}`);
      const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      this.urls.push(url);
      return url;
    })();

    this.renders.set(key, promise);
    // A failed render shouldn't be cached forever — let a retry through
    promise.catch(() => this.renders.delete(key));
    return promise;
  }

  clear() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.renders.clear();
    for (const assetId of this.documents.keys()) bridge.pdfClose?.(assetId);
    this.documents.clear();
  }
}
