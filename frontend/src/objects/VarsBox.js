import katex from "katex";
import { registerObjectType } from "./registry.js";
import { createObject } from "../model/document.js";
import { linesOf, lineTex } from "../sim/variables.js";

// ─────────────────────────────────────────────
//  VARIABLES BOX
//
//  One definition a line:
//
//    m = 2 kg
//    k = 200 N/m
//    w_n = sqrt(k/m)
//
//  Every Variables box in the notebook feeds
//  one shared list (see sim/variables.js), and
//  simulations, formulas and plots read from it.
//
//  Shown as typeset maths with each worked value;
//  double-click to edit the text, like a LaTeX box.
// ─────────────────────────────────────────────
export const VARS_DEFAULT_SOURCE = "m = 2 kg\nk = 200 N/m\nw_n = sqrt(k/m)";

export function createVarsObject(x, y, source = VARS_DEFAULT_SOURCE) {
  return createObject({
    type: "vars",
    x, y, w: 260, h: 120,
    payload: { source },
  });
}

function render(output, object) {
  output.innerHTML = "";
  const lines = linesOf(object.id);
  if (!lines || !lines.some((l) => l.kind !== "comment" || l.text.trim())) {
    output.innerHTML = `<span class="ntbk-latex-empty">no variables — double-click to add</span>`;
    return;
  }
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = "ntbk-vars-line";
    if (line.kind === "comment") {
      if (!line.text.trim()) continue;
      row.classList.add("is-comment");
      row.textContent = line.text.replace(/^\s*[#%]\s?/, "");
    } else if (line.kind === "error") {
      row.classList.add("is-bad");
      const code = document.createElement("code");
      code.textContent = line.text.trim();
      const why = document.createElement("span");
      why.textContent = line.error;
      row.append(code, why);
    } else {
      try {
        katex.render(lineTex(line), row, { throwOnError: true, strict: false, trust: false });
      } catch {
        row.textContent = `${line.name} = ${line.expr}`;
      }
    }
    output.appendChild(row);
  }
}

registerObjectType("vars", {
  mount(el, object, context) {
    el.classList.add("ntbk-latex", "ntbk-vars");
    el.innerHTML = `
      <div class="ntbk-box-tabs">
        <button class="ntbk-tab" data-tab="source">Edit</button>
        <button class="ntbk-tab is-active" data-tab="output">Variables</button>
      </div>
      <div class="ntbk-box-body">
        <textarea class="ntbk-latex-source ntbk-no-pan" spellcheck="false"
          placeholder="one per line:  name = value"></textarea>
        <div class="ntbk-latex-output ntbk-vars-output"></div>
      </div>`;

    const tabs = [...el.querySelectorAll(".ntbk-tab")];
    const source = el.querySelector(".ntbk-latex-source");
    const output = el.querySelector(".ntbk-latex-output");
    source.value = object.payload.source ?? "";

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

    // Typing must not reach the canvas, where letters are tool shortcuts
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

    output.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      show("source");
    });
    el.addEventListener("ntbk:edit", () => show("source"));

    // A value here can depend on a box further up the notebook, so every box
    // redraws whenever any variable changes, not only when it is edited
    const redraw = () => render(output, object);
    window.addEventListener("ntbk:variables-read", redraw);
    redraw();

    return {
      update(next) {
        object = next;
        if (source.value !== next.payload.source) source.value = next.payload.source ?? "";
        redraw();
      },
      destroy() {
        window.removeEventListener("ntbk:variables-read", redraw);
      },
    };
  },
});
