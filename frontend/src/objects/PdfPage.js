import { registerObjectType } from "./registry.js";
import { createObject } from "../model/document.js";
import { PdfService } from "../pdf/PdfService.js";

// ─────────────────────────────────────────────
//  PDF PAGE
//
//  One object per page, the way OneNote's file
//  printout works — so a single page can be
//  moved, resized or deleted on its own, and
//  annotations stay glued to their page.
//
//  Sits under the ink, so marking it up is just
//  drawing. The source PDF is never modified.
// ─────────────────────────────────────────────
export function createPdfPageObject({ assetId, pageNumber, x, y, w, h, source }) {
  return createObject({
    type: "pdfpage",
    x, y, w, h,
    payload: { asset: assetId, page: pageNumber, source },
  });
}

registerObjectType("pdfpage", {
  mount(el, object, context) {
    el.classList.add("ntbk-pdfpage");

    const img = document.createElement("img");
    img.draggable = false;
    img.alt = "";
    el.appendChild(img);

    let current = object;
    let renderedBucket = null;

    async function draw(bucket) {
      const asset = context.assets.get(current.payload.asset);
      if (!asset) {
        el.classList.add("is-missing");
        el.dataset.missing = "PDF missing from this .ntbk";
        return;
      }
      el.classList.remove("is-missing");

      try {
        const url = await context.pdf.renderPage(
          asset.id, asset.bytes, current.payload.page, current.w, bucket);
        img.src = url;
        renderedBucket = bucket;
      } catch (error) {
        el.classList.add("is-missing");
        el.dataset.missing = `Could not render page ${current.payload.page}`;
      }
    }

    draw(PdfService.bucketFor(context.scale()));

    return {
      update(next) {
        const resized = next.w !== current.w;
        current = next;
        if (resized) { renderedBucket = null; draw(PdfService.bucketFor(context.scale())); }
      },
      /**
       * Called when the view zoom changes. Re-rasterises at a higher
       * resolution once you go in close, so small print stays readable
       * instead of turning to mush.
       */
      onZoom(scale) {
        const bucket = PdfService.bucketFor(scale);
        if (bucket !== renderedBucket) draw(bucket);
      },
    };
  },
});
