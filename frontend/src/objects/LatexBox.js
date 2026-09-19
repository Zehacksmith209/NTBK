import katex from "katex";
import "katex/dist/katex.min.css";
import { registerObjectType } from "./registry.js";
import { createObject } from "../model/document.js";

// ─────────────────────────────────────────────
//  LATEX BOX
//
//  Two tabs, as specified: source and output.
//
//  The chrome only appears on hover or when the
//  box is selected. Left visible all the time,
//  an opaque panel sits on the page hiding
//  whatever it overlaps — which is the thing
//  that made the Qt version feel bolted on
//  rather than written on the page.
// ─────────────────────────────────────────────
export const LATEX_DEFAULT_SOURCE = "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";

export function createLatexObject(x, y, source = LATEX_DEFAULT_SOURCE) {
  return createObject({
    type: "latex",
    x, y, w: 240, h: 96,
    payload: { source, engine: "katex", displayMode: true, macros: {} },
  });
}

function render(outputEl, payload) {
  const source = (payload.source ?? "").trim();
  if (!source) {
    outputEl.innerHTML = `<span class="ntbk-latex-empty">empty</span>`;
    return;
  }
  try {
    katex.render(source, outputEl, {
      displayMode: payload.displayMode !== false,
      throwOnError: true,
      macros: payload.macros ?? {},
      strict: false,
      trust: false,       // no \href or \includegraphics from a shared file
    });
  } catch (error) {
    // A typo shouldn't blank the box — show what KaTeX objected to
    outputEl.innerHTML = "";
    const message = document.createElement("pre");
    message.className = "ntbk-latex-error";
    message.textContent = String(error.message ?? error).replace(/^KaTeX parse error:\s*/, "");
    outputEl.appendChild(message);
  }
}

registerObjectType("latex", {
  mount(el, object, context) {
    el.classList.add("ntbk-latex");
    el.innerHTML = `
      <div class="ntbk-box-tabs">
        <button class="ntbk-tab" data-tab="source">LaTeX</button>
        <button class="ntbk-tab is-active" data-tab="output">Output</button>
      </div>
      <div class="ntbk-box-body">
        <textarea class="ntbk-latex-source ntbk-no-pan" spellcheck="false"></textarea>
        <div class="ntbk-latex-output"></div>
      </div>`;

    const tabs = [...el.querySelectorAll(".ntbk-tab")];
    const source = el.querySelector(".ntbk-latex-source");
    const output = el.querySelector(".ntbk-latex-output");

    source.value = object.payload.source ?? "";
    render(output, object.payload);

    const show = (name) => {
      el.dataset.tab = name;
      for (const tab of tabs) tab.classList.toggle("is-active", tab.dataset.tab === name);
      if (name === "source") source.focus();
    };
    show("output");

    for (const tab of tabs) {
      tab.addEventListener("pointerdown", (event) => event.stopPropagation());
      tab.addEventListener("click", (event) => {
        event.stopPropagation();
        show(tab.dataset.tab);
      });
    }

    // Typing must not reach the canvas, or every keystroke would be a shortcut
    source.addEventListener("pointerdown", (event) => event.stopPropagation());
    source.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commit();
        show("output");
      }
    });
    source.addEventListener("blur", commit);

    function commit() {
      if (source.value === object.payload.source) return;
      context.updateObjectPayload(object.id, { ...object.payload, source: source.value });
    }

    // Double-click the rendered maths to get back to the source
    output.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      show("source");
    });
    // Same thing, routed from the canvas when the selection chrome is
    // covering the box and swallowed the double-click itself
    el.addEventListener("ntbk:edit", () => show("source"));

    return {
      update(next) {
        object = next;
        if (source.value !== next.payload.source) source.value = next.payload.source ?? "";
        render(output, next.payload);
      },
      destroy() {},
    };
  },
});
