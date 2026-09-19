import { registerObjectType } from "./registry.js";
import { createObject } from "../model/document.js";

// ─────────────────────────────────────────────
//  IMAGE
//
//  A real <img>, not a canvas draw. That matters:
//  animated GIFs only animate in the DOM, and the
//  browser applies EXIF orientation to an <img>
//  by itself, so phone photos come in the right
//  way up without an orientation library.
//
//  Sits in the content layer, under the ink, so
//  annotating it is just drawing on top. The
//  original pixels are never touched.
// ─────────────────────────────────────────────
export function createImageObject({ assetId, x, y, w, h, naturalW, naturalH, mime }) {
  return createObject({
    type: "image",
    x, y, w, h,
    payload: { asset: assetId, naturalW, naturalH, mime },
  });
}

registerObjectType("image", {
  mount(el, object, context) {
    el.classList.add("ntbk-image");

    const img = document.createElement("img");
    img.draggable = false;
    img.alt = "";
    el.appendChild(img);

    const apply = (next) => {
      const url = context.assets.urlFor(next.payload.asset);
      if (url) {
        img.src = url;
        el.classList.remove("is-missing");
      } else {
        // The asset didn't come with the file — say so rather than
        // showing an empty box the user can't explain
        img.removeAttribute("src");
        el.classList.add("is-missing");
        el.dataset.missing = "Image missing from this .ntbk";
      }
    };

    apply(object);
    return { update: apply };
  },
});
