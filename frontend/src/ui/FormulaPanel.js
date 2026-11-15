import katex from "katex";
import {
  loadFormulas, saveFormulas, createFormula, parseDefinition, definitionTex, calculate,
  symbolTex,
} from "../formulas/library.js";

// ─────────────────────────────────────────────
//  FORMULA PANEL
//
//  The library, opened from Insert > Formulas.
//  A list on top, and under it whichever formula
//  is picked: put it on the page as LaTeX, or
//  type values into it and get the answer.
// ─────────────────────────────────────────────

const typeset = (target, latex, display = false) => {
  try {
    katex.render(latex, target, { displayMode: display, throwOnError: true,
                                  strict: false, trust: false });
    target.classList.remove("is-bad");
  } catch (error) {
    target.classList.add("is-bad");
    target.textContent = String(error.message ?? error).replace(/^KaTeX parse error:\s*/, "");
  }
};

/** What a formula shows as: its own LaTeX, or LaTeX written from its calculable form. */
export function latexOf(formula) {
  if (formula.latex?.trim()) return formula.latex.trim();
  const definition = parseDefinition(formula.calc);
  return definition.ok ? definitionTex(definition) : "";
}

export class FormulaPanel {
  constructor(app) {
    this.app = app;
    this.root = null;
    this.items = [];
    this.selectedId = null;
    this.query = "";
    this.category = "";
    this.draft = null;        // the formula being added or edited, if any
    this.values = {};         // what was typed into each formula's inputs
  }

  get open() { return !!this.root; }

  async toggle() {
    if (this.open) this.close(); else await this.show();
  }

  async show() {
    if (this.root) return;
    const root = document.createElement("div");
    root.className = "ntbk-formulas";
    root.innerHTML = `
      <div class="ntbk-formulas-head">
        <strong>Formulas</strong>
        <button class="ntbk-mini" data-new>+ New</button>
        <button class="ntbk-graph-x" data-close title="Close">×</button>
      </div>
      <div class="ntbk-formulas-filter">
        <input type="text" data-search placeholder="Search formulas" spellcheck="false">
        <select data-category></select>
      </div>
      <div class="ntbk-formulas-list"></div>
      <div class="ntbk-formulas-detail"></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.list = root.querySelector(".ntbk-formulas-list");
    this.detail = root.querySelector(".ntbk-formulas-detail");
    this.categorySelect = root.querySelector("[data-category]");

    // Typing in the panel must never reach the canvas, where a letter is a
    // tool shortcut and Backspace deletes the selection.
    root.addEventListener("keydown", (event) => event.stopPropagation());

    root.querySelector("[data-close]").addEventListener("click", () => this.close());
    root.querySelector("[data-new]").addEventListener("click", () => this.edit(null));
    const search = root.querySelector("[data-search]");
    search.addEventListener("input", () => { this.query = search.value; this.renderList(); });
    this.categorySelect.addEventListener("change", () => {
      this.category = this.categorySelect.value;
      this.renderList();
    });
    this._wireDrag(root.querySelector(".ntbk-formulas-head"));

    this.items = await loadFormulas();
    this.selectedId = this.items[0]?.id ?? null;
    this.render();
  }

  close() {
    this.root?.remove();
    this.root = null;
    this.draft = null;
  }

  /** The title bar moves the panel, so it can be put beside the work. */
  _wireDrag(handle) {
    let from = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const box = this.root.getBoundingClientRect();
      from = { x: event.clientX - box.left, y: event.clientY - box.top };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!from) return;
      const x = Math.max(0, Math.min(window.innerWidth - 80, event.clientX - from.x));
      const y = Math.max(0, Math.min(window.innerHeight - 40, event.clientY - from.y));
      Object.assign(this.root.style, { left: `${x}px`, top: `${y}px`, right: "auto" });
    });
    const end = () => { from = null; };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  async persist() {
    const result = await saveFormulas(this.items);
    if (result?.ok === false) this.app._flash?.(`Could not save formulas: ${result.error ?? ""}`);
  }

  categories() {
    return [...new Set(this.items.map((f) => f.category?.trim()).filter(Boolean))].sort();
  }

  render() {
    this.renderCategories();
    this.renderList();
    this.renderDetail();
  }

  renderCategories() {
    const select = this.categorySelect;
    const all = this.categories();
    if (this.category && !all.includes(this.category)) this.category = "";
    select.innerHTML = "";
    for (const [value, label] of [["", "All topics"], ...all.map((c) => [c, c])]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = this.category;
  }

  renderList() {
    const needle = this.query.trim().toLowerCase();
    const shown = this.items.filter((f) =>
      (!this.category || (f.category ?? "") === this.category)
      && (!needle || [f.name, f.category, f.latex, f.calc]
        .some((text) => (text ?? "").toLowerCase().includes(needle))));

    this.list.innerHTML = "";
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "ntbk-formulas-empty";
      empty.textContent = this.items.length
        ? "Nothing matches that."
        : "No formulas yet. Press + New to add your first.";
      this.list.appendChild(empty);
      return;
    }

    let heading = null;
    const ordered = [...shown].sort((a, b) =>
      (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));
    for (const formula of ordered) {
      const group = formula.category?.trim() || "Uncategorised";
      if (group !== heading) {
        heading = group;
        const label = document.createElement("div");
        label.className = "ntbk-formulas-group";
        label.textContent = group;
        this.list.appendChild(label);
      }
      const row = document.createElement("button");
      row.className = "ntbk-formulas-row";
      row.classList.toggle("is-current", formula.id === this.selectedId);
      const name = document.createElement("span");
      name.className = "ntbk-formulas-name";
      name.textContent = formula.name || "Untitled";
      const preview = document.createElement("span");
      preview.className = "ntbk-formulas-preview";
      const latex = latexOf(formula);
      if (latex) typeset(preview, latex);
      row.append(name, preview);
      row.addEventListener("click", () => {
        this.selectedId = formula.id;
        this.draft = null;
        this.renderList();
        this.renderDetail();
      });
      this.list.appendChild(row);
    }
  }

  renderDetail() {
    if (this.draft) { this.renderEditor(); return; }
    this.detail.innerHTML = "";
    const formula = this.items.find((f) => f.id === this.selectedId);
    if (!formula) return;

    const latex = latexOf(formula);
    const view = document.createElement("div");
    view.className = "ntbk-formulas-view";
    if (latex) typeset(view, latex, true);
    this.detail.appendChild(view);

    const actions = document.createElement("div");
    actions.className = "ntbk-formulas-actions";
    const button = (label, title, run, primary = false) => {
      const el = document.createElement("button");
      el.className = primary ? "ntbk-primary" : "ntbk-mini";
      el.textContent = label;
      el.title = title;
      el.addEventListener("click", run);
      actions.appendChild(el);
      return el;
    };
    // First and filled in, because putting a formula on the page as LaTeX is
    // what the library is for most of the time.
    button("Insert as LaTeX", "Put this formula on the page", () => {
      if (latex) this.app.insertLatex(latex);
    }, true).disabled = !latex;
    button("Edit", "Change this formula", () => this.edit(formula));
    // Asked twice on the button itself rather than in a system dialog: the
    // library is one shared file, and a formula deleted from it is gone.
    const del = button("Delete", "Remove it from the library", () => {
      if (del.dataset.armed) { this.remove(formula); return; }
      del.dataset.armed = "1";
      del.textContent = "Really delete?";
      del.classList.add("is-danger");
      setTimeout(() => {
        if (!del.isConnected) return;
        delete del.dataset.armed;
        del.textContent = "Delete";
        del.classList.remove("is-danger");
      }, 3000);
    });
    this.detail.appendChild(actions);

    if (formula.calc?.trim()) this.renderCalculator(formula);
  }

  /** Inputs for every value the formula needs, and the answer as they are filled in. */
  renderCalculator(formula) {
    const definition = parseDefinition(formula.calc);
    const box = document.createElement("div");
    box.className = "ntbk-formulas-calc";
    const title = document.createElement("div");
    title.className = "ntbk-formulas-group";
    title.textContent = "Calculate";
    box.appendChild(title);

    if (!definition.ok) {
      const bad = document.createElement("div");
      bad.className = "ntbk-formulas-result is-bad";
      bad.textContent = `Cannot calculate: ${definition.error}`;
      box.appendChild(bad);
      this.detail.appendChild(box);
      return;
    }

    const typed = (this.values[formula.id] ??= {});
    const result = document.createElement("div");
    result.className = "ntbk-formulas-result";
    const insert = document.createElement("button");
    insert.className = "ntbk-mini";
    insert.textContent = "Insert result";
    insert.title = "Put the worked answer on the page";
    let lastTex = "";

    const work = () => {
      const answer = calculate(definition, typed);
      result.classList.toggle("is-bad", !answer.ok && !answer.missing);
      insert.disabled = !answer.ok;
      if (answer.ok) {
        lastTex = answer.tex;
        typeset(result, answer.tex);
      } else {
        lastTex = "";
        result.textContent = answer.missing
          ? `Enter ${answer.missing.join(", ")}`
          : answer.error;
      }
    };

    const rows = document.createElement("div");
    rows.className = "ntbk-formulas-inputs";
    box.appendChild(rows);
    for (const name of definition.inputs) {
      const row = document.createElement("label");
      row.className = "ntbk-formulas-input";
      const label = document.createElement("span");
      typeset(label, `${symbolTex(name)} =`);
      const field = document.createElement("input");
      field.type = "text";
      field.spellcheck = false;
      field.value = typed[name] ?? "";
      field.placeholder = "value";
      field.addEventListener("input", () => { typed[name] = field.value; work(); });
      row.append(label, field);
      rows.appendChild(row);
    }

    insert.addEventListener("click", () => { if (lastTex) this.app.insertLatex(lastTex); });
    box.append(result, insert);
    const hint = document.createElement("div");
    hint.className = "ntbk-formulas-hint";
    hint.textContent = "A value can be a number, an expression like 2*pi, "
      + "or carry a unit like 3 m/s^2.";
    box.appendChild(hint);
    this.detail.appendChild(box);
    work();
  }

  /** Add a new formula, or change one. `formula` is null for a new one. */
  edit(formula) {
    if (formula) {
      this.draft = { ...formula };
    } else {
      // Starting from the equation that is selected on the page saves typing
      // it twice, which is the usual reason a formula gets added at all.
      const picked = [...this.app.selection].map((id) => this.app.store.find(id))
        .find((element) => element?.type === "latex");
      this.draft = createFormula({
        latex: picked?.payload?.source ?? "",
        category: this.category,
      });
      this.draft.isNew = true;
    }
    this.renderEditor();
  }

  renderEditor() {
    const draft = this.draft;
    this.detail.innerHTML = "";
    const form = document.createElement("div");
    form.className = "ntbk-formulas-form";

    const field = (label, key, { area = false, placeholder = "", list = null } = {}) => {
      const row = document.createElement("label");
      row.className = "ntbk-formulas-field";
      const caption = document.createElement("span");
      caption.textContent = label;
      const input = document.createElement(area ? "textarea" : "input");
      if (!area) input.type = "text";
      input.spellcheck = false;
      input.placeholder = placeholder;
      input.value = draft[key] ?? "";
      if (list) input.setAttribute("list", list);
      input.addEventListener("input", () => { draft[key] = input.value; refresh(); });
      row.append(caption, input);
      form.appendChild(row);
      return input;
    };

    const nameInput = field("Name", "name", { placeholder: "Kinetic energy" });
    field("Topic", "category", { placeholder: "Mechanics", list: "ntbk-formula-topics" });
    const topics = document.createElement("datalist");
    topics.id = "ntbk-formula-topics";
    for (const category of this.categories()) {
      const option = document.createElement("option");
      option.value = category;
      topics.appendChild(option);
    }
    form.appendChild(topics);

    // LaTeX comes first: it is how most formulas arrive, copied from notes
    // or typed the way they are written.
    field("LaTeX", "latex", { area: true, placeholder: "E_k = \\tfrac{1}{2} m v^2" });
    field("Calculable form (optional)", "calc", { placeholder: "E_k(m, v) = 1/2*m*v^2" });

    const preview = document.createElement("div");
    preview.className = "ntbk-formulas-view";
    form.appendChild(preview);
    const status = document.createElement("div");
    status.className = "ntbk-formulas-hint";
    form.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "ntbk-formulas-actions";
    const save = document.createElement("button");
    save.className = "ntbk-primary";
    save.textContent = draft.isNew ? "Add to library" : "Save";
    const cancel = document.createElement("button");
    cancel.className = "ntbk-mini";
    cancel.textContent = "Cancel";
    actions.append(save, cancel);
    form.appendChild(actions);

    const refresh = () => {
      const definition = draft.calc?.trim() ? parseDefinition(draft.calc) : null;
      const latex = latexOf(draft);
      preview.innerHTML = "";
      if (latex) typeset(preview, latex, true);

      const problems = [];
      if (!draft.latex?.trim() && !draft.calc?.trim()) problems.push("Enter the formula as LaTeX, in calculable form, or both.");
      if (definition && !definition.ok) problems.push(`Calculable form: ${definition.error}`);
      status.classList.toggle("is-bad", problems.length > 0 && !!(draft.latex?.trim() || draft.calc?.trim()));
      status.textContent = problems[0]
        ?? (definition
          ? `Will ask for: ${definition.inputs.join(", ") || "nothing"}`
            + (draft.latex?.trim() ? "" : " · LaTeX written from the calculable form")
          : "Add a calculable form, like f(x) = x^2 + 1, to work out values with it.");
      save.disabled = problems.length > 0 || !latex;
    };

    save.addEventListener("click", () => {
      const { isNew, ...clean } = draft;
      clean.name = clean.name?.trim() || "Untitled";
      clean.category = clean.category?.trim() ?? "";
      if (isNew) this.items.push(clean);
      else this.items = this.items.map((f) => (f.id === clean.id ? clean : f));
      this.selectedId = clean.id;
      this.draft = null;
      this.persist();
      this.render();
    });
    cancel.addEventListener("click", () => { this.draft = null; this.renderDetail(); });

    this.detail.appendChild(form);
    refresh();
    nameInput.focus();
  }

  remove(formula) {
    this.items = this.items.filter((f) => f.id !== formula.id);
    delete this.values[formula.id];
    this.selectedId = this.items[0]?.id ?? null;
    this.persist();
    this.render();
  }
}
