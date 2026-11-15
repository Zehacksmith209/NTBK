// Vite copies the prebuilt bundle into dist and hands back a local URL, so
// this still ships offline — nothing is fetched from a CDN at runtime.
import mathjaxUrl from "mathjax-full/es5/tex-svg.js?url";

// ─────────────────────────────────────────────
//  MATHS, FOR EXPORT ONLY
//
//  On screen the app uses KaTeX: it is fast, and
//  Tiptap's maths extension is wired to it with
//  no way to swap the renderer.
//
//  KaTeX only ever emits HTML, positioned with
//  inline-block boxes sitting on an empty strut.
//  Where that strut lands is decided by the
//  browser's baseline rules, and WKWebView and
//  Chromium do not agree — which is why the same
//  export drifted by 3px in the app but not in
//  the dev browser, and why measuring it in one
//  engine never predicted the other.
//
//  MathJax's SVG output carries its own layout in
//  its own coordinates. There is no strut and no
//  baseline to guess at, so the question that
//  produced the drift stops being asked.
//
//  Everything is re-rendered from the stored
//  LaTeX source, so this covers maths inside text
//  boxes as well as standalone equations — which
//  is what makes it worth doing without touching
//  the editor.
//
//  The bundle is 2MB, so it is fetched on the
//  first export and never during startup.
// ─────────────────────────────────────────────

let loading = null;

/** Load MathJax once. Safe to call on every export. */
export function ensureMaths() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    // Has to be set before the bundle runs — it reads this as it starts.
    window.MathJax = {
      startup: { typeset: false },   // never let it walk the live page
      svg: {
        // "none" inlines every glyph path rather than pointing at a shared
        // cache elsewhere in the document. Bigger, but each equation is then
        // self-contained — which it must be, because these get lifted out one
        // at a time and handed to a canvas or to MuPDF, where a <use> aimed
        // at a <defs> left behind renders as nothing at all.
        fontCache: "none",
      },
      options: { enableMenu: false },
    };
    const script = document.createElement("script");
    script.src = mathjaxUrl;
    script.async = true;
    script.onload = () => window.MathJax.startup.promise.then(resolve, reject);
    script.onerror = () => reject(new Error("MathJax bundle failed to load"));
    document.head.appendChild(script);
  }).catch((error) => {
    loading = null;          // let a later export try again
    throw error;
  });
  return loading;
}

/**
 * Typeset one LaTeX string to a self-contained SVG element.
 *
 * Returns null rather than throwing: one half-typed equation must never take
 * the whole export down with it. Call ensureMaths() first.
 */
export function typesetToSvg(latex, displayMode = false) {
  if (!latex || !latex.trim()) return null;
  if (!window.MathJax?.tex2svg) return null;
  try {
    const container = window.MathJax.tex2svg(latex, { display: !!displayMode });
    const svg = container.querySelector("svg");
    if (!svg) return null;
    svg.removeAttribute("focusable");
    svg.setAttribute("role", "img");
    return svg;
  } catch {
    return null;
  }
}

/** The LaTeX behind a rendered KaTeX node, wherever it happens to be kept. */
export function sourceOf(katexEl) {
  // Tiptap keeps it on the wrapping span; KaTeX keeps it in the MathML
  // annotation it renders alongside the visible HTML.
  const tagged = katexEl.closest("[data-latex]");
  const attr = tagged?.getAttribute("data-latex");
  if (attr) return attr;
  const annotation = katexEl.querySelector('annotation[encoding="application/x-tex"]');
  return annotation?.textContent ?? null;
}
