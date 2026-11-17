import { createIcons, icons } from "lucide";
import {
  buildExpressionRows, buildViewPresets, buildViewSliders, buildStatsControls,
  buildViewControls,
} from "../objects/GraphBox.js";
import {
  compile2d, compile3d, surfacesOf, zoomBounds, panBounds, zoomOf, DEFAULT_SPAN,
} from "../graph/GraphRenderer.js";
import katex from "katex";
import { analyse, intersections } from "../graph/analysis.js";
import { formatValue, formatPoint } from "../graph/exact.js";

// ─────────────────────────────────────────────
//  INSPECTOR
//
//  Right-click a row in the object tree to ask
//  "what IS this and where does it live?".
//
//  The tree can only show a name. This is where
//  the page, the layer, the size and the contents
//  actually get answered.
// ─────────────────────────────────────────────
const TYPE_NAMES = {
  latex: "Formula (LaTeX)", image: "Image", pdfpage: "PDF page",
  graph: "Plot", code: "Code cell", text: "Text", video: "Video",
  vars: "Variables", sim: "Simulation",
  rect: "Rectangle", ellipse: "Ellipse", line: "Line",
  arrow: "Arrow", triangle: "Triangle",
};

const TABS = [
  ["details", "Details"],
  ["editor", "Editor"],
  ["layer", "Layer"],
];

let open = null;
let lastTab = "details";       // reopening lands where you left off

export function closeInspector() {
  if (!open) return;
  open.unsubscribe?.();
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("keydown", onEscape, true);
  window.removeEventListener("resize", open.reposition);
  open.el.remove();
  open = null;
}

function onOutside(event) {
  if (open && !open.el.contains(event.target)) closeInspector();
}

function onEscape(event) {
  if (event.key === "Escape") closeInspector();
}

export function openInspector(app, id, anchor) {
  closeInspector();
  if (!app.store.find(id)) return null;

  const el = document.createElement("div");
  el.className = "ntbk-inspector";
  document.body.appendChild(el);

  const draw = () => {
    const element = app.store.find(id);
    // Deleted while the panel was open: nothing left to inspect
    if (!element) return closeInspector();
    el.innerHTML = "";
    el.appendChild(header(app, element));
    el.appendChild(tabStrip(() => draw()));
    el.appendChild(body(app, element, draw));
    place(el, anchor);
    // Icons arrive a tick later and change the height, so the clamp that keeps
    // the panel on screen has to be run again once they are in
    queueMicrotask(() => {
      createIcons({ icons, root: el });
      place(el, anchor);
    });
  };

  // Moving or restyling it while the panel is open should show up in it —
  // unless you are mid-edit in here, because a rebuild would take the field
  // away under your hands
  const unsubscribe = app.store.subscribe(() => {
    const focused = document.activeElement;
    if (el.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return;
    draw();
  });
  const reposition = () => place(el, anchor);
  window.addEventListener("resize", reposition);
  open = { el, unsubscribe, reposition };
  draw();

  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("keydown", onEscape, true);
  }, 0);
  return el;
}

function place(el, anchor) {
  const size = el.getBoundingClientRect();
  let rect = anchor?.getBoundingClientRect?.();
  // A row rebuilt under us is detached and measures 0×0. Staying put beats
  // leaping to the corner.
  if (rect && !rect.width && !rect.height) rect = el.style.left ? null : undefined;

  const x = rect ? rect.right + 8 : (rect === null ? parseFloat(el.style.left) : 120);
  const y = rect ? rect.top : (rect === null ? parseFloat(el.style.top) : 120);
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - size.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - size.height - 8))}px`;
}

function header(app, element) {
  const el = document.createElement("div");
  el.className = "ntbk-insp-head";
  el.innerHTML = `
    <strong>${escapeHtml(element.name ?? "Item")}</strong>
    <button class="ntbk-insp-close" title="Close"><i data-lucide="x"></i></button>`;
  el.querySelector(".ntbk-insp-close").addEventListener("click", closeInspector);
  return el;
}

function tabStrip(redraw) {
  const el = document.createElement("div");
  el.className = "ntbk-insp-tabs";
  for (const [value, label] of TABS) {
    const tab = document.createElement("button");
    tab.className = "ntbk-insp-tab";
    tab.classList.toggle("is-active", value === lastTab);
    tab.textContent = label;
    tab.addEventListener("click", () => { lastTab = value; redraw(); });
    el.appendChild(tab);
  }
  return el;
}

function body(app, element, redraw) {
  const el = document.createElement("div");
  el.className = "ntbk-insp-body";
  if (lastTab === "details") detailsTab(el, app, element);
  else if (lastTab === "editor") editorTab(el, app, element, redraw);
  else layerTab(el, app, element, redraw);
  return el;
}

/** label / value pair */
function field(parent, label, value) {
  const row = document.createElement("div");
  row.className = "ntbk-insp-field";
  row.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const right = document.createElement("strong");
  right.textContent = value;
  row.appendChild(right);
  parent.appendChild(row);
  return row;
}

function typeNameOf(element) {
  if (element.kind === "shape") return TYPE_NAMES[element.shape] ?? "Shape";
  if (element.kind) return element.kind === "pen" ? "Pen stroke" : "Highlighter stroke";
  return TYPE_NAMES[element.type] ?? element.type;
}

function boundsOf(app, element) {
  if (element.kind) return app.selectionController.boundsOf([element.id]);
  return {
    minX: element.x, minY: element.y,
    maxX: element.x + (element.w ?? 0), maxY: element.y + (element.h ?? 0),
  };
}

// Exact or decimal, remembered across redraws of the panel. Deliberately not
// saved into the document: it is how you want to READ the numbers today, not
// something about the plot itself.
let coordMode = "decimal";

function detailsTab(el, app, element) {
  const page = app.pageContaining(element);
  const layer = (app.store.data.canvas.layers ?? []).find((l) => l.id === element.layerId);
  const bounds = boundsOf(app, element);

  field(el, "What it is", typeNameOf(element));
  field(el, "Page", page ? `Page ${page.index + 1}` : "Off-page");
  field(el, "Layer", layer?.name ?? "—");
  // Which deck of the layer it sits on, which is what decides whether your
  // pen lands on top of it or under it
  field(el, "Against ink", element.band === "over" ? "Above the ink" : "Under the ink");

  if (bounds) {
    field(el, "Position", `${Math.round(bounds.minX)}, ${Math.round(bounds.minY)}`);
    field(el, "Size", `${Math.round(bounds.maxX - bounds.minX)} × ${Math.round(bounds.maxY - bounds.minY)}`);
  }
  if (element.rotation) field(el, "Rotation", `${element.rotation}°`);
  if (element.flipX || element.flipY) {
    field(el, "Flipped", [element.flipX && "horizontally", element.flipY && "vertically"]
      .filter(Boolean).join(" and "));
  }

  field(el, "Visible", element.visible === false ? "No — hidden" : "Yes");
  field(el, "Locked", element.locked ? "Yes — not editable" : "No");

  if (element.type === "graph" && element.payload?.kind === "function2d") {
    functionFacts(el, app, element);
  }
}

/**
 * What the plotted functions actually do, over the x range on screen.
 *
 * Every number here is measured by sampling, so each is only true of the
 * window it was measured in. "Highest in view" can change when you pan, and
 * saying so in the label is the difference between a useful panel and a
 * misleading one.
 */
function functionFacts(el, app, element) {
  const spec = app.store.find(element.id).payload;
  const list = (spec.functions ?? []).filter((f) => (f.expr ?? "").trim());
  if (!list.length) return;

  const [xMin, , xMax] = spec.bounds ?? [-8, 6, 8, -6];
  const bounds = [xMin, xMax];

  const head = document.createElement("div");
  head.className = "ntbk-insp-facts-head";
  const caption = document.createElement("span");
  caption.textContent = `In view: x from ${formatValue(xMin, "decimal", 2)} `
    + `to ${formatValue(xMax, "decimal", 2)}`;
  head.appendChild(caption);

  const toggle = document.createElement("button");
  toggle.className = "ntbk-mini";
  toggle.title = "Switch between exact and decimal coordinates";
  const relabel = () => { toggle.textContent = coordMode === "exact" ? "Exact" : "Decimal"; };
  relabel();
  toggle.addEventListener("click", () => {
    coordMode = coordMode === "exact" ? "decimal" : "exact";
    relabel();
    for (const node of [...el.querySelectorAll(".ntbk-insp-fn")]) node.remove();
    draw();
  });
  head.appendChild(toggle);
  el.appendChild(head);

  const num = (v) => formatValue(v, coordMode);
  const pt = (x, y) => formatPoint(x, y, coordMode);

  function draw() {
    let solutions = 0;

    for (const fn of list) {
      const box = document.createElement("div");
      box.className = "ntbk-insp-fn";

      const title = document.createElement("div");
      title.className = "ntbk-insp-fn-title";
      const dot = document.createElement("span");
      dot.className = "ntbk-insp-dot";
      dot.style.background = fn.color;
      title.appendChild(dot);
      title.appendChild(document.createTextNode(`y = ${fn.expr}`));
      box.appendChild(title);

      const a = analyse(fn.expr, bounds);
      if (!a.ok) {
        const bad = document.createElement("div");
        bad.className = "ntbk-insp-fn-row";
        bad.textContent = a.error;
        box.appendChild(bad);
        el.appendChild(box);
        continue;
      }

      fact(box, "Domain", a.wholeWindowDefined
        ? `all of ${num(xMin)} to ${num(xMax)}`
        : a.domain.map(([lo, hi]) => `${num(lo)} to ${num(hi)}`).join(", "));
      fact(box, "Range", a.unbounded
        ? "unbounded — asymptote in view"
        : `${num(a.range[0])} to ${num(a.range[1])}`);

      // A turning point is a real maximum of the function. The window extreme
      // is often just where the view was cut off, so the two are named
      // differently rather than both being called "max".
      const maxima = a.turning.filter((t) => t.kind === "max");
      const minima = a.turning.filter((t) => t.kind === "min");
      if (maxima.length) fact(box, "Maximum", maxima.map((t) => pt(t.x, t.y)).join("   "));
      if (minima.length) fact(box, "Minimum", minima.map((t) => pt(t.x, t.y)).join("   "));
      if (a.crowded) {
        fact(box, "Note", `oscillates rapidly — ${a.turningCount} turning points in view,`
          + " showing the first few");
      }
      if (!maxima.length && !minima.length && !a.unbounded) {
        fact(box, "Highest in view", pt(a.max.x, a.max.y));
        fact(box, "Lowest in view", pt(a.min.x, a.min.y));
      }

      solutions += a.rootCount;
      const shownRoots = a.roots.map((x) => pt(x, 0)).join("   ");
      const moreRoots = a.rootCount - a.roots.length;
      fact(box, `Roots (${a.rootCount})`,
        a.rootCount
          ? (moreRoots > 0 ? `${shownRoots}   … and ${moreRoots} more` : shownRoots)
          : "none in view");

      el.appendChild(box);
    }

    // Where two curves meet — the other thing "solution" can mean
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const meets = intersections(list[i].expr, list[j].expr, bounds);
        if (!meets.length) continue;
        solutions += meets.length;
        const shownMeets = meets.slice(0, 24);
        const moreMeets = meets.length - shownMeets.length;
        const box = document.createElement("div");
        box.className = "ntbk-insp-fn";
        const title = document.createElement("div");
        title.className = "ntbk-insp-fn-title";
        title.textContent = `${list[i].expr} = ${list[j].expr}`;
        box.appendChild(title);
        fact(box, `Intersections (${meets.length})`,
          shownMeets.map((m) => pt(m.x, m.y)).join("   ")
            + (moreMeets > 0 ? `   … and ${moreMeets} more` : ""));
        el.appendChild(box);
      }
    }

    const total = document.createElement("div");
    total.className = "ntbk-insp-fn ntbk-insp-fn-total";
    total.textContent = `${solutions} solution${solutions === 1 ? "" : "s"} in view`;
    el.appendChild(total);
  }

  draw();
}

/** One label/value line inside a function block. */
function fact(parent, label, value) {
  const row = document.createElement("div");
  row.className = "ntbk-insp-fn-row";
  const name = document.createElement("span");
  name.textContent = label;
  const v = document.createElement("b");
  v.textContent = value;
  row.appendChild(name);
  row.appendChild(v);
  parent.appendChild(row);
}

const SWATCHES = [
  "#111111", "#1a6ef5", "#c62828", "#2e7d32",
  "#f57c00", "#6a1b9a", "#00838f", "#777777",
];

/** A labelled control row. */
function control(parent, label) {
  const row = document.createElement("div");
  row.className = "ntbk-insp-field";
  row.innerHTML = `<span>${escapeHtml(label)}</span>`;
  parent.appendChild(row);
  return row;
}

/**
 * Commit on blur and on Enter, never on every keystroke: each commit is a
 * history entry, and one per character would bury the undo stack.
 */
function textRow(parent, label, value, commit, { type = "text" } = {}) {
  const row = control(parent, label);
  const input = document.createElement("input");
  input.type = type;
  input.className = "ntbk-insp-input";
  input.value = value ?? "";
  const send = () => {
    const next = type === "number" ? Number(input.value) : input.value;
    if (String(next) !== String(value) && (type !== "number" || Number.isFinite(next))) commit(next);
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    if (event.key === "Escape") { input.value = value ?? ""; input.blur(); }
  });
  input.addEventListener("blur", send);
  row.appendChild(input);
  return input;
}

function areaRow(parent, label, value, commit) {
  const wrap = document.createElement("div");
  wrap.className = "ntbk-insp-block";
  wrap.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const area = document.createElement("textarea");
  area.className = "ntbk-insp-area";
  area.value = value ?? "";
  area.spellcheck = false;
  area.addEventListener("keydown", (event) => {
    event.stopPropagation();
    // Enter inserts a newline here, so committing needs its own chord
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      area.blur();
    }
    if (event.key === "Escape") { area.value = value ?? ""; area.blur(); }
  });
  area.addEventListener("blur", () => { if (area.value !== value) commit(area.value); });
  wrap.appendChild(area);
  parent.appendChild(wrap);
  return area;
}

function note(parent, text) {
  const el = document.createElement("p");
  el.className = "ntbk-insp-note";
  el.textContent = text;
  parent.appendChild(el);
}

function editorTab(el, app, element, redraw) {
  // Everything has a name
  textRow(el, "Name", element.name ?? "", (value) => {
    if (value.trim()) app.renameElement(element.id, value.trim());
  });

  if (element.kind) return strokeEditor(el, app, element);

  switch (element.type) {
    case "latex": return latexEditor(el, app, element);
    case "text": return textEditor(el, app, element);
    case "code": return codeEditor(el, app, element);
    case "graph": return plotEditor(el, app, element, redraw);
    case "video": return videoEditor(el, app, element);
    case "sim": return simEditor(el, app, element);
    case "image":
    case "pdfpage": return boxEditor(el, app, element);
    default: return note(el, "Nothing to edit for this type yet.");
  }
}

function strokeEditor(el, app, element) {
  const row = control(el, "Colour");
  const swatches = document.createElement("div");
  swatches.className = "ntbk-insp-swatches";
  for (const value of SWATCHES) {
    const dot = document.createElement("button");
    dot.className = "ntbk-insp-dot is-button";
    dot.style.background = value;
    dot.title = value;
    dot.classList.toggle("is-current", element.style?.color === value);
    dot.addEventListener("click", () => app.setElementStyle(element.id, { color: value }));
    swatches.appendChild(dot);
  }
  row.appendChild(swatches);

  textRow(el, "Thickness", element.style?.size ?? 2,
    (value) => app.setElementStyle(element.id, { size: Math.max(0.5, value) }),
    { type: "number" });
  textRow(el, "Opacity", element.style?.opacity ?? 1,
    (value) => app.setElementStyle(element.id, { opacity: Math.min(1, Math.max(0.05, value)) }),
    { type: "number" });

  // Rotate and flip act on the selection, so the panel makes sure the thing
  // you are looking at IS the selection before firing them
  const act = (run) => { app.setSelection([element.id]); run(); };

  const rotate = control(el, "Rotate");
  const rotateGroup = document.createElement("div");
  rotateGroup.className = "ntbk-insp-presets";
  for (const [label, degrees] of [["\u21ba 90", -90], ["\u21ba 45", -45],
                                  ["\u21bb 45", 45], ["\u21bb 90", 90]]) {
    const button = document.createElement("button");
    button.className = "ntbk-mini";
    button.textContent = label;
    button.title = `Rotate ${Math.abs(degrees)}\u00b0 ${degrees < 0 ? "anti" : ""}clockwise`;
    button.addEventListener("click", () => act(() => app.rotateSelection(degrees)));
    rotateGroup.appendChild(button);
  }
  rotate.appendChild(rotateGroup);

  const flip = control(el, "Flip");
  const flipGroup = document.createElement("div");
  flipGroup.className = "ntbk-insp-presets";
  for (const [label, axis, title] of [["\u21c6 Horizontal", "x", "Mirror left to right"],
                                      ["\u21c5 Vertical", "y", "Mirror top to bottom"]]) {
    const button = document.createElement("button");
    button.className = "ntbk-mini";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", () => act(() => app.flipSelection(axis)));
    flipGroup.appendChild(button);
  }
  flip.appendChild(flipGroup);
}

function textEditor(el, app, element) {
  const id = element.id;
  const payload = () => app.store.find(id).payload;

  textRow(el, "Font size", payload().fontSize ?? 16, (value) => {
    app.updateObjectPayload(id, { ...payload(), fontSize: Math.min(96, Math.max(6, value)) },
      "Font size");
  }, { type: "number" });

  const row = control(el, "Colour");
  const swatches = document.createElement("div");
  swatches.className = "ntbk-insp-swatches";
  for (const value of SWATCHES) {
    const dot = document.createElement("button");
    dot.className = "ntbk-insp-dot is-button";
    dot.style.background = value;
    dot.title = value;
    dot.classList.toggle("is-current", payload().color === value);
    dot.addEventListener("click", () =>
      app.updateObjectPayload(id, { ...payload(), color: value }, "Text colour"));
    swatches.appendChild(dot);
  }
  row.appendChild(swatches);

  const foot = document.createElement("div");
  foot.className = "ntbk-insp-foot";
  const bold = document.createElement("button");
  bold.className = "ntbk-mini";
  bold.innerHTML = "<strong>B</strong>&nbsp; Bold";
  bold.title = "Bold the selected text, or what you type next";
  bold.addEventListener("click", () => app.objectHandle(id)?.toggleBold?.());
  foot.appendChild(bold);
  el.appendChild(foot);

  boxEditor(el, app, element);
  note(el, "Type $x^2$ for inline maths, $$\u2026$$ for a display line \u2014 it "
    + "typesets as you go.");
}

function latexEditor(el, app, element) {
  const id = element.id;
  const preview = document.createElement("div");
  preview.className = "ntbk-insp-preview";

  // The same render the box does, so a typo shows its KaTeX error here
  // rather than silently doing nothing on the canvas
  const show = (source) => {
    try {
      katex.render(source, preview, {
        throwOnError: true, displayMode: true, strict: false, trust: false,
      });
      preview.classList.remove("is-bad");
    } catch (error) {
      preview.classList.add("is-bad");
      preview.textContent = String(error.message ?? error)
        .replace(/^KaTeX parse error:\s*/, "");
    }
  };

  const area = areaRow(el, "LaTeX source", element.payload.source ?? "", (value) => {
    app.updateObjectPayload(id, { ...app.store.find(id).payload, source: value },
      "Edit LaTeX");
  });
  // Typing previews here immediately; the document is written on blur
  area.addEventListener("input", () => show(area.value));
  el.appendChild(preview);
  show(element.payload.source ?? "");

  boxEditor(el, app, element);
  note(el, "\u2318/Ctrl + Enter applies it to the box on the canvas.");
}

function codeEditor(el, app, element) {
  textRow(el, "File", element.payload.filename ?? "", (value) => {
    if (value.trim()) {
      app.updateObjectPayload(element.id,
        { ...element.payload, filename: value.trim() }, "Rename file");
    }
  });
  const language = app.languageName?.(element.payload.filename);
  if (language) {
    const row = control(el, "Language");
    const tag = document.createElement("strong");
    tag.textContent = language;
    row.appendChild(tag);
  }
  textRow(el, "Run command", element.payload.runCommand ?? "", (value) => {
    app.updateObjectPayload(element.id,
      { ...element.payload, runCommand: value }, "Set run command");
  });
  areaRow(el, "Source", element.payload.source ?? "", (value) => {
    app.updateObjectPayload(element.id, { ...element.payload, source: value }, "Edit code");
  });

  const foot = document.createElement("div");
  foot.className = "ntbk-insp-foot";
  const run = document.createElement("button");
  run.className = "ntbk-mini";
  run.textContent = "\u25b6 Run";
  run.title = "Run this cell — output appears in the cell's own terminal";
  run.addEventListener("click", () => app.objectHandle(element.id)?.run?.());
  const stop = document.createElement("button");
  stop.className = "ntbk-mini";
  stop.textContent = "\u25a0 Stop";
  stop.title = "Interrupt it; press again to kill it outright";
  stop.addEventListener("click", () => app.objectHandle(element.id)?.stop?.());
  foot.append(run, stop);
  el.appendChild(foot);

  note(el, "Output goes to the cell's terminal on the canvas. Nothing here ever "
    + "runs on its own.");
}

const PLOT_COLORS = [
  "#1a6ef5", "#c62828", "#2e7d32", "#f57c00", "#6a1b9a", "#00838f",
];

function plotEditor(el, app, element, redraw) {
  const id = element.id;
  const spec = () => app.store.find(id).payload;
  const is3d = spec().kind === "surface3d";
  const key = is3d ? "surfaces" : spec().functions ? "functions" : null;
  // Older documents stored a 3D plot as one bare expression; normalise so
  // they edit exactly like new ones
  const items = () => (is3d ? surfacesOf(spec()) : spec()[key] ?? []);

  // Typing shows the plot change immediately, but a history entry per
  // keystroke would bury the undo stack — so the live edit is a preview and
  // one entry is recorded when you leave the field.
  let base = null;
  const beginEdit = () => { base = base ?? clone(spec()); };

  // The debounce means the store can still be a few keystrokes behind when
  // you click away, and blur fires first — so a commit always flushes what is
  // waiting, or the tail of what you typed would be dropped.
  let waiting = null;
  const apply = debounce((payload) => { waiting = null; app.previewObjectPayload(id, payload); });
  const previewSoon = (payload) => { waiting = payload; apply(payload); };
  const flushPreview = () => {
    if (!waiting) return;
    apply.flush();
    app.previewObjectPayload(id, waiting);
    waiting = null;
  };

  const finishEdit = (label) => {
    if (!base) return;
    flushPreview();
    const after = spec();
    if (JSON.stringify(base) !== JSON.stringify(after)) {
      app.recordPayloadEdit(id, base, clone(after), label);
    }
    base = null;
  };

  if (key) {
    const list = document.createElement("div");
    list.className = "ntbk-insp-rows";
    buildExpressionRows(list, items(), {
      prefix: is3d ? "z =" : "y =",
      validate: is3d ? compile3d : compile2d,
      onEdit: (index, value, ok, input) => {
        beginEdit();
        const next = items().map((f, i) => (i === index ? { ...f, expr: value } : f));
        // Only a valid expression reaches the plotter; the text is kept either
        // way so what you typed is never yanked out from under you
        if (ok) previewSoon({ ...spec(), [key]: next });
        input.onblur = () => finishEdit("Edit plot");
      },
      onRemove: (index) => {
        const next = items().filter((_, i) => i !== index);
        if (!next.length) return;      // a plot with nothing on it is just a box
        app.updateObjectPayload(id, { ...spec(), [key]: next }, "Remove function");
        redraw();
      },
    });
    el.appendChild(list);

    const foot = document.createElement("div");
    foot.className = "ntbk-insp-foot";
    const add = document.createElement("button");
    add.className = "ntbk-mini";
    add.textContent = key === "surfaces" ? "+ Add surface" : "+ Add function";
    add.addEventListener("click", () => {
      const list2 = items();
      const color = PLOT_COLORS[list2.length % PLOT_COLORS.length];
      const expr = key === "surfaces" ? "x*y/4" : "sin(x)";
      app.updateObjectPayload(id, { ...spec(), [key]: [...list2, { expr, color }] },
        "Add function");
      redraw();
      const inputs = el.querySelectorAll(".ntbk-ge-row input");
      inputs[inputs.length - 1]?.select();
    });
    foot.appendChild(add);

    if (spec().bounds) {
      const reset = document.createElement("button");
      reset.className = "ntbk-mini";
      reset.textContent = "Reset view";
      reset.addEventListener("click", () => {
        app.updateObjectPayload(id, { ...spec(), bounds: [-8, 6, 8, -6] }, "Reset view");
        redraw();
      });
      foot.appendChild(reset);
    }
    el.appendChild(foot);
  }

  if (spec().kind === "surface3d") {
    // Mesh or solid. JSXGraph fixes this when the element is built, so the
    // change is written to the spec and the board is rebuilt — there is no
    // attribute to flip on a live surface.
    const shadeRow = control(el, "Surface");
    const modes = document.createElement("div");
    modes.className = "ntbk-insp-presets";
    for (const [value, label] of [["wireframe", "Mesh"], ["shaded", "Shaded"]]) {
      const button = document.createElement("button");
      button.className = "ntbk-popover-mode";
      button.textContent = label;
      button.classList.toggle("is-active", (spec().shading ?? "wireframe") === value);
      button.addEventListener("click", () => {
        if ((spec().shading ?? "wireframe") === value) return;
        app.updateObjectPayload(id, { ...spec(), shading: value }, "Surface style");
        for (const other of modes.children) other.classList.remove("is-active");
        button.classList.add("is-active");
        redraw?.();
      });
      modes.appendChild(button);
    }
    shadeRow.appendChild(modes);

    const row = control(el, "View");
    const presets = document.createElement("div");
    presets.className = "ntbk-insp-presets";
    let sliders = null;
    buildViewPresets(presets, (preset) => {
      app.setPlotView(id, preset);
      // Move the knobs to match the preset they just applied
      const view = spec().view ?? {};
      for (const [key, handle] of Object.entries(sliders ?? {})) {
        handle.range.value = view[key] ?? 0;
        handle.show();
      }
    });
    row.appendChild(presets);

    // A drag touches NOTHING but the board's camera.
    //
    // Writing the view to the store per frame changes the payload signature,
    // which makes GraphBox rebuild the whole board — ~113ms each — so the
    // slider fought a rebuild on every pointermove and juddered. The dragged
    // value is held here and written to the document once, on release.
    let pending = null;
    sliders = buildViewSliders(el, spec().view, {
      onMove: (key, value) => {
        pending = { ...(pending ?? spec().view), [key]: value };
        app.objectHandle(id)?.applyView?.(pending);
      },
      onSettle: () => {
        if (!pending) return;
        app.updateObjectPayload(id, { ...spec(), view: pending }, "Turn plot");
        pending = null;
      },
    });
  }

  if (spec().kind === "stats") {
    const list = document.createElement("div");
    list.className = "ntbk-insp-rows";
    let dataBase = null;
    buildStatsControls(list, spec(), {
      onChart: (value) =>
        app.updateObjectPayload(id, { ...spec(), chartType: value }, "Change chart"),
      onData: (values) => {
        // Live while typing, one entry when the box loses focus
        dataBase = dataBase ?? clone(spec());
        previewSoon({ ...spec(), data: values });
      },
    });
    const area = list.querySelector("textarea");
    area.addEventListener("blur", () => {
      flushPreview();
      if (!dataBase) return;
      app.recordPayloadEdit(id, dataBase, clone(spec()), "Edit data");
      dataBase = null;
    });
    el.appendChild(list);
  }

  // bounds is JSXGraph's order: [xmin, ymax, xmax, ymin]
  if (spec().bounds) {
    const range = (label, read, write) => textRow(el, label, read(spec().bounds), (value) => {
      const [min, max] = value.split(/[,\s]+/).map(Number);
      if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
        app.updateObjectPayload(id, { ...spec(), bounds: write(spec().bounds, min, max) },
          "Change range");
      }
    });
    range("x range", (b) => `${b[0]}, ${b[2]}`, (b, min, max) => [min, b[1], max, b[3]]);
    range("y range", (b) => `${b[3]}, ${b[1]}`, (b, min, max) => [b[0], max, b[2], min]);
  }

  // ── Getting around the region ──
  const is2d = !!spec().bounds;
  const span = is2d
    ? spec().bounds[2] - spec().bounds[0]
    : (spec().xRange?.[1] ?? 5) - (spec().xRange?.[0] ?? -5);
  const reference = is2d ? DEFAULT_SPAN.x2d : DEFAULT_SPAN.x3d;

  let zoomBase = null;
  buildViewControls(el, {
    zoom: zoomOf(span, reference),
    depth: !is2d,
    onZoom: (value, settled) => {
      // Live while dragging, one history entry when you let go
      zoomBase = zoomBase ?? clone(spec());
      const factor = value / zoomOf(
        is2d ? zoomBase.bounds[2] - zoomBase.bounds[0]
             : zoomBase.xRange[1] - zoomBase.xRange[0], reference);
      const next = is2d
        ? { ...spec(), bounds: zoomBounds(zoomBase.bounds, factor) }
        : {
            ...spec(),
            xRange: scaleAbout(zoomBase.xRange, factor),
            yRange: scaleAbout(zoomBase.yRange, factor),
            zRange: scaleAbout(zoomBase.zRange, factor),
          };
      if (settled) {
        app.recordPayloadEdit(id, zoomBase, clone(next), "Zoom");
        app.previewObjectPayload(id, next);
        zoomBase = null;
      } else {
        app.previewObjectPayload(id, next);
      }
    },
    onPan: (dx, dy, dz, home = false) => {
      const current = spec();
      if (home) {
        // Back to a region centred on the origin, keeping the zoom
        const centre = (r) => {
          const half = (r[1] - r[0]) / 2;
          return [-half, half];
        };
        const next = is2d
          ? { ...current, bounds: (() => {
              const hx = (current.bounds[2] - current.bounds[0]) / 2;
              const hy = (current.bounds[1] - current.bounds[3]) / 2;
              return [-hx, hy, hx, -hy];
            })() }
          : { ...current, xRange: centre(current.xRange),
              yRange: centre(current.yRange), zRange: centre(current.zRange) };
        app.updateObjectPayload(id, next, "Centre");
        redraw();
        return;
      }
      const next = is2d
        ? { ...current, bounds: panBounds(current.bounds, dx, -dy) }
        : {
            ...current,
            xRange: shiftBy(current.xRange, dx),
            yRange: shiftBy(current.yRange, dy),
            zRange: shiftBy(current.zRange, dz),
          };
      app.updateObjectPayload(id, next, "Pan");
      redraw();
    },
  });

  boxEditor(el, app, element);

  const button = document.createElement("button");
  button.className = "ntbk-insp-button";
  button.textContent = "Open the full plot editor";
  button.addEventListener("click", () => app.editElement(id));
  el.appendChild(button);
}

function simEditor(el, app, element) {
  const button = document.createElement("button");
  button.className = "ntbk-insp-button";
  button.textContent = "Open inputs, graphs and results";
  button.addEventListener("click", () => { closeInspector(); app.editElement(element.id); });
  el.appendChild(button);
}

function scaleAbout([min, max], factor) {
  const centre = (min + max) / 2;
  const half = ((max - min) / 2) / factor;
  return [centre - half, centre + half];
}

function shiftBy([min, max], fraction) {
  const step = (max - min) * fraction;
  return [min + step, max + step];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Coalesce a burst of edits into one.
 *
 * Every preview redraws the plot, and a 3D board costs ~113ms to rebuild, so
 * previewing per keystroke makes typing an expression unusable. A short wait
 * means you get the redraw when you pause, not between letters.
 */
function debounce(fn, wait = 140) {
  let timer = null;
  const run = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  run.flush = () => clearTimeout(timer);
  return run;
}

/** Size, for anything with a real box. */
function videoEditor(el, app, element) {
  const id = element.id;
  textRow(el, "Address", element.payload?.url ?? "", (value) => {
    app.updateObjectPayload(id, { ...app.store.find(id).payload, url: String(value).trim() },
      "Change video");
  });
  boxEditor(el, app, element);
  note(el, "Plays from the internet, so it needs a connection. Nothing is "
    + "saved into the notebook except the address.");
}

function boxEditor(el, app, element) {
  textRow(el, "Width", Math.round(element.w ?? 0),
    (value) => app.setElementBox(element.id, { w: Math.max(20, value) }), { type: "number" });
  textRow(el, "Height", Math.round(element.h ?? 0),
    (value) => app.setElementBox(element.id, { h: Math.max(20, value) }), { type: "number" });

  if (element.type === "image" && element.payload?.naturalW) {
    const button = document.createElement("button");
    button.className = "ntbk-insp-button";
    button.textContent = "Reset to original size";
    button.addEventListener("click", () => app.setElementBox(element.id, {
      w: element.payload.naturalW, h: element.payload.naturalH,
    }));
    el.appendChild(button);
  }
}

function layerTab(el, app, element, redraw) {
  const layers = app.store.data.canvas.layers ?? [];
  const layer = layers.find((l) => l.id === element.layerId);

  const row = document.createElement("div");
  row.className = "ntbk-insp-field";
  row.innerHTML = "<span>On layer</span>";
  const select = document.createElement("select");
  select.className = "ntbk-insp-select";
  for (const l of layers) {
    const option = document.createElement("option");
    option.value = l.id;
    option.textContent = l.name;
    select.appendChild(option);
  }
  select.value = element.layerId ?? "";
  select.addEventListener("change", () => {
    app.setSelection([element.id]);
    app.moveSelectionToLayer(select.value);
    redraw();
  });
  row.appendChild(select);
  el.appendChild(row);

  if (layer) {
    field(el, "Layer is", layer.visible === false ? "Hidden" : "Visible");
    field(el, "Layer lock", layer.locked ? "Locked" : "Unlocked");
    const mates = [...app.store.strokes, ...app.store.objects]
      .filter((e) => e.layerId === layer.id && e.id !== element.id).length;
    field(el, "Sharing it with", mates === 1 ? "1 other item" : `${mates} other items`);
    // Layer 1 is the top of the stack, so position in the list IS the depth
    const depth = layers.indexOf(layer);
    field(el, "Stacking", depth === 0
      ? "Topmost layer"
      : `${depth} layer${depth === 1 ? "" : "s"} above`);
  }

  const note = document.createElement("p");
  note.className = "ntbk-insp-note";
  note.textContent = "Moving it keeps its position on the page.";
  el.appendChild(note);
}

function pre(parent, label, text) {
  const wrap = document.createElement("div");
  wrap.className = "ntbk-insp-block";
  wrap.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const box = document.createElement("pre");
  box.textContent = text;
  wrap.appendChild(box);
  parent.appendChild(wrap);
  return wrap;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
