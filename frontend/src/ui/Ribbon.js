import { computePosition, offset, flip, shift } from "@floating-ui/dom";
import { createIcons, icons } from "lucide";
import Pickr from "@simonwep/pickr";
import { typeableReadout } from "./NumberField.js";
import "@simonwep/pickr/dist/themes/nano.min.css";

// ─────────────────────────────────────────────
//  RIBBON
//
//  SolidWorks-ish: a tab strip over a band of
//  labelled groups. Deliberately plain — the
//  chrome stays boring so the ink and the
//  typeset maths are what you look at.
// ─────────────────────────────────────────────
export function buildRibbon(app) {
  const root = document.createElement("div");
  root.className = "ntbk-ribbon";

  const config = ribbonConfig(app);

  const tabStrip = document.createElement("div");
  tabStrip.className = "ntbk-ribbon-tabs";
  const panels = document.createElement("div");
  panels.className = "ntbk-ribbon-panels";

  config.forEach((tab, index) => {
    const tabButton = document.createElement("button");
    tabButton.className = "ntbk-ribbon-tab";
    tabButton.textContent = tab.name;
    tabButton.addEventListener("click", () => select(index));
    tabStrip.appendChild(tabButton);

    const panel = document.createElement("div");
    panel.className = "ntbk-ribbon-panel";
    for (const group of tab.groups) panel.appendChild(buildGroup(app, group));
    panels.appendChild(panel);
  });

  function select(index) {
    [...tabStrip.children].forEach((el, i) => el.classList.toggle("is-active", i === index));
    [...panels.children].forEach((el, i) => el.classList.toggle("is-active", i === index));
  }

  root.append(tabStrip, panels);
  select(1); // open on Home — that's where you actually start
  queueMicrotask(() => createIcons({ icons, root }));
  return root;
}

function buildGroup(app, group) {
  const el = document.createElement("div");
  el.className = "ntbk-group";

  const items = document.createElement("div");
  items.className = "ntbk-group-items";
  for (const item of group.items) items.appendChild(buildItem(app, item));

  const label = document.createElement("div");
  label.className = "ntbk-group-label";
  label.textContent = group.name;

  el.append(items, label);
  return el;
}

function buildItem(app, item) {
  const wrap = document.createElement("div");
  wrap.className = "ntbk-item";

  const button = document.createElement("button");
  button.className = "ntbk-button";
  button.title = item.tooltip ?? item.label;
  button.innerHTML = `<i data-lucide="${item.icon}"></i><span>${item.label}</span>`;
  if (item.disabled) button.disabled = true;
  if (item.id) button.dataset.action = item.id;
  if (item.toolName) button.dataset.tool = item.toolName;
  button.addEventListener("click", () => item.action?.(app));
  wrap.appendChild(button);

  if (item.menu) {
    const caret = document.createElement("button");
    caret.className = "ntbk-caret";
    caret.innerHTML = `<i data-lucide="chevron-down"></i>`;
    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(app, caret, item.menu);
    });
    wrap.appendChild(caret);
    wrap.classList.add("has-menu");
  }

  return wrap;
}

/**
 * Your own shapes, saved beside the notebook.
 *
 * They are ordinary files in a `shapes/` folder, which is what lets you drag
 * them into another topic's folder and have them show up there.
 */
function buildCustomShapes(app, panel, close) {
  const divider = document.createElement("div");
  divider.className = "ntbk-popover-divider";
  panel.appendChild(divider);

  const head = document.createElement("div");
  head.className = "ntbk-popover-hint";
  head.textContent = "Your shapes";
  panel.appendChild(head);

  // A filter, once there are enough shapes for scanning the list to be work.
  // Below that it is just a box in the way.
  const search = document.createElement("div");
  search.className = "ntbk-shape-search";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search your shapes";
  searchInput.spellcheck = false;
  search.appendChild(searchInput);
  panel.appendChild(search);

  const list = document.createElement("div");
  list.className = "ntbk-popover-modes ntbk-shape-list";
  list.style.flexWrap = "wrap";
  panel.appendChild(list);

  const save = document.createElement("button");
  save.className = "ntbk-popover-mode";
  save.style.width = "100%";
  save.style.marginTop = "4px";
  save.textContent = "+ Save selection as a shape";
  save.title = "Select some strokes, then name them and reuse them anywhere";
  save.addEventListener("click", async () => {
    const name = window.prompt("Name this shape");
    if (!name) return;
    close();
    await app.saveSelectionAsShape(name.trim());
  });
  panel.appendChild(save);

  app.loadShapes().then((shapes) => {
    if (!shapes.length) {
      const empty = document.createElement("div");
      empty.className = "ntbk-popover-hint";
      empty.textContent = "None yet. Draw something, select it, then save it.";
      list.appendChild(empty);
      return;
    }

    const draw = (query) => {
      const needle = query.trim().toLowerCase();
      const matches = needle
        ? shapes.filter((entry) => entry.name.toLowerCase().includes(needle))
        : shapes;
      list.innerHTML = "";

      if (!matches.length) {
        const none = document.createElement("div");
        none.className = "ntbk-popover-hint";
        none.textContent = `Nothing matches "${query.trim()}"`;
        list.appendChild(none);
        return;
      }
      for (const entry of matches) {
        const button = document.createElement("button");
        button.className = "ntbk-popover-mode";
        button.style.flex = "1 1 44%";
        button.textContent = entry.name;
        button.title = "Click to drop it on the page";
        button.addEventListener("click", () => {
          close();
          app.placeCustomShape(entry);
        });
        list.appendChild(button);
      }
      return matches;
    };

    draw("");
    searchInput.addEventListener("input", () => draw(searchInput.value));
    searchInput.addEventListener("keydown", (event) => {
      event.stopPropagation();          // never let typing reach the canvas
      if (event.key === "Escape") {
        searchInput.value = "";
        draw("");
        return;
      }
      // Enter drops the first match, so a search can be finished without
      // moving back to the mouse
      if (event.key === "Enter") {
        const needle = searchInput.value.trim().toLowerCase();
        const first = needle
          ? shapes.find((entry) => entry.name.toLowerCase().includes(needle))
          : null;
        if (first) {
          close();
          app.placeCustomShape(first);
        }
      }
    });
  });
}

// ── Dropdowns ───────────────────────────────
let openPopover = null;

function closePopover() {
  openPopover?.remove();
  openPopover = null;
  document.removeEventListener("pointerdown", onOutside, true);
}

function onOutside(event) {
  if (openPopover && !openPopover.contains(event.target)) closePopover();
}

function openMenu(app, reference, builder) {
  closePopover();
  const panel = document.createElement("div");
  panel.className = "ntbk-popover";
  builder(app, panel, closePopover);
  document.body.appendChild(panel);
  openPopover = panel;

  computePosition(reference, panel, {
    placement: "bottom-start",
    middleware: [offset(4), flip(), shift({ padding: 8 })],
  }).then(({ x, y }) => Object.assign(panel.style, { left: `${x}px`, top: `${y}px` }));

  setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  queueMicrotask(() => createIcons({ icons, root: panel }));
}

/** Colour + thickness editor, shared by pen and highlighter. */
function styleMenu(kind) {
  return (app, panel) => {
    const settings = app.settings[kind];

    const colorRow = document.createElement("div");
    colorRow.className = "ntbk-popover-row";
    colorRow.innerHTML = `<label>Colour</label><div class="ntbk-pickr"></div>`;
    panel.appendChild(colorRow);

    const sizeRow = document.createElement("div");
    sizeRow.className = "ntbk-popover-row";
    sizeRow.innerHTML = `
      <label>Thickness</label>
      <input type="range" min="0.5" max="${kind === "highlighter" ? 60 : 24}"
             step="0.5" value="${settings.size}">
      <output>${settings.size}</output>`;
    panel.appendChild(sizeRow);

    const hint = document.createElement("div");
    hint.className = "ntbk-popover-hint";
    hint.textContent = "Applies to the selection if there is one.";
    panel.appendChild(hint);

    const pickr = Pickr.create({
      el: colorRow.querySelector(".ntbk-pickr"),
      theme: "nano",
      default: settings.color,
      useAsButton: false,
      components: {
        preview: true, opacity: kind === "highlighter", hue: true,
        interaction: { input: true, save: true },
      },
    });
    pickr.on("save", (color) => {
      if (!color) return;
      const value = color.toHEXA().toString();
      app.applyStyle(kind, { color: value });
      pickr.hide();
    });

    const range = sizeRow.querySelector("input");
    range.addEventListener("input", () => {
      app.applyStyle(kind, { size: Number(range.value) });
    });
    typeableReadout(range, sizeRow.querySelector("output"), { decimals: 1 });
  };
}

/** Eraser mode buttons plus the size slider. */
function eraserMenu(app, panel, close) {
  const modes = document.createElement("div");
  modes.className = "ntbk-popover-modes";
  for (const [label, tool, hint] of [
    ["Whole stroke", "eraser_stroke", "Removes any stroke it touches"],
    ["Partial", "eraser_partial", "Cuts away only what it covers"],
  ]) {
    const button = document.createElement("button");
    button.className = "ntbk-popover-mode";
    button.textContent = label;
    button.title = hint;
    button.classList.toggle("is-active", app.toolName === tool);
    button.addEventListener("click", () => {
      app.setTool(tool);
      for (const other of modes.children) other.classList.remove("is-active");
      button.classList.add("is-active");
    });
    modes.appendChild(button);
  }
  panel.appendChild(modes);

  const sizeRow = document.createElement("div");
  sizeRow.className = "ntbk-popover-row";
  sizeRow.innerHTML = `
    <label>Size</label>
    <input type="range" min="6" max="120" step="2" value="${app.settings.eraser.size}">
    <output>${app.settings.eraser.size}</output>`;
  panel.appendChild(sizeRow);

  const range = sizeRow.querySelector("input");
  range.addEventListener("input", () => {
    app.settings.eraser.size = Number(range.value);
  });
  typeableReadout(range, sizeRow.querySelector("output"), { decimals: 0 });
}

function ribbonConfig(app) {
  return [
    {
      name: "File",
      groups: [
        {
          name: "Document",
          items: [
            { label: "New", icon: "file-plus",
              tooltip: "Start a fresh notebook in this window",
              action: (a) => a.newDocument() },
            { label: "New window", icon: "copy-plus",
              tooltip: "A second notebook alongside this one, in its own window",
              action: (a) => a.newWindow() },
            { label: "Open", icon: "folder-open", action: (a) => a.openDocument() },
            { label: "Save as", icon: "save",
              tooltip: "Save this notebook \u2014 choose where it goes",
              action: (a) => a.saveDocument(),
              menu: (app, panel, close) => {
                for (const [label, hint, run] of [
                  [".ntbk notebook", "The editable file, with every asset inside",
                    () => app.saveDocument()],
                  ["PDF", "Every A4 page, exactly as it will print",
                    () => app.exportPdf()],
                ]) {
                  const button = document.createElement("button");
                  button.className = "ntbk-popover-mode";
                  button.style.width = "100%";
                  button.style.marginBottom = "4px";
                  button.textContent = label;
                  button.title = hint;
                  button.addEventListener("click", () => { close(); run(); });
                  panel.appendChild(button);
                }
                const html = document.createElement("button");
                html.className = "ntbk-popover-mode";
                html.style.width = "100%";
                html.textContent = "HTML page";
                html.disabled = true;
                html.title = "Coming later \u2014 3D plots need rasterising first";
                panel.appendChild(html);
              } },
          ],
        },
        {
          name: "Export",
          items: [
            { label: "PDF", icon: "file-text",
              tooltip: "Write every A4 page to a PDF",
              action: (a) => a.exportPdf(),
              menu: (app, panel, close) => {
                for (const [label, hint, clip] of [
                  ["Whole page", "Everything on the A4 sheet, margins included", false],
                  ["Printable area only",
                    "Blanks the strips a printer cannot reach, so the PDF matches the paper",
                    true],
                ]) {
                  const button = document.createElement("button");
                  button.className = "ntbk-popover-mode";
                  button.style.width = "100%";
                  button.style.marginBottom = "4px";
                  button.textContent = label;
                  button.title = hint;
                  button.addEventListener("click", () => {
                    close();
                    app.exportPdf({ clipToMargins: clip });
                  });
                  panel.appendChild(button);
                }
                const note = document.createElement("div");
                note.className = "ntbk-popover-hint";
                note.textContent = "Content off the page is never exported either way.";
                panel.appendChild(note);
              } },
            { label: "Print", icon: "printer",
              tooltip: "Print the A4 pages \u2014 nothing off the page is included",
              action: (a) => a.exportPdf({ print: true }) },
          ],
        },
      ],
    },
    {
      name: "Home",
      groups: [
        {
          name: "History",
          items: [
            { id: "undo", label: "Undo", icon: "undo-2", action: (a) => a.history.undo() },
            { id: "redo", label: "Redo", icon: "redo-2", action: (a) => a.history.redo() },
          ],
        },
        {
          name: "Tools",
          items: [
            { label: "Select", icon: "mouse-pointer-2", toolName: "select",
              action: (a) => a.setTool("select") },
            { label: "Pen", icon: "pen-line", toolName: "pen",
              action: (a) => a.setTool("pen"), menu: styleMenu("pen") },
            { label: "Highlighter", icon: "highlighter", toolName: "highlighter",
              action: (a) => a.setTool("highlighter"), menu: styleMenu("highlighter") },
            { label: "Eraser", icon: "eraser", toolName: "eraser_stroke",
              tooltip: "Eraser — whole stroke or partial",
              action: (a) => a.setTool("eraser_stroke"), menu: eraserMenu },
          ],
        },
        {
          name: "Draw",
          items: [
            { label: "Shapes", icon: "shapes", toolName: "shape_rect",
              tooltip: "Line, arrow, rectangle, ellipse, triangle — hold shift to square up",
              action: (a) => a.setTool("shape_rect"),
              menu: (app, panel, close) => {
                const modes = document.createElement("div");
                modes.className = "ntbk-popover-modes";
                modes.style.flexWrap = "wrap";
                for (const [kind, label] of [
                  ["line", "Line"], ["arrow", "Arrow"], ["rect", "Rectangle"],
                  ["ellipse", "Ellipse"], ["triangle", "Triangle"],
                ]) {
                  const button = document.createElement("button");
                  button.className = "ntbk-popover-mode";
                  button.style.flex = "1 1 44%";
                  button.textContent = label;
                  button.classList.toggle("is-active", app.toolName === `shape_${kind}`);
                  button.addEventListener("click", () => {
                    app.setTool(`shape_${kind}`);
                    for (const other of modes.children) other.classList.remove("is-active");
                    button.classList.add("is-active");
                  });
                  modes.appendChild(button);
                }
                panel.appendChild(modes);
                styleMenu("shape")(app, panel, close);
                buildCustomShapes(app, panel, close);
              } },
            { label: "Text", icon: "type", toolName: "text",
              tooltip: "Click the page to start typing \u2014 $x^2$ typesets as maths",
              action: (a) => a.setTool("text") },
          ],
        },
        {
          name: "Edit",
          items: [
            { label: "Delete", icon: "trash-2", action: (a) => a.deleteSelection() },
          ],
        },
        {
          name: "View",
          items: [
            { label: "Zoom in", icon: "zoom-in", action: (a) => a.scene.zoomBy(1.25) },
            { label: "Zoom out", icon: "zoom-out", action: (a) => a.scene.zoomBy(0.8) },
            { label: "Reset", icon: "maximize", action: (a) => a.scene.resetView() },
          ],
        },
      ],
    },
    {
      name: "Tools",
      groups: [
        {
          name: "Instruments",
          items: [
            { id: "ruler", label: "Ruler", icon: "ruler",
              tooltip: "A 30cm ruler with a protractor \u2014 ink snaps to its edge",
              action: (a) => a.toggleRuler(),
              menu: (app, panel, close) => {
                const row = document.createElement("div");
                row.className = "ntbk-popover-row";
                row.innerHTML = "<label>Length</label>";
                const input = document.createElement("input");
                input.type = "number";
                input.className = "ntbk-number";
                input.min = "5";
                input.max = "100";
                input.value = String(app.ruler.lengthCm);
                input.addEventListener("change", () => {
                  app.setRulerLength(Number(input.value));
                });
                const unit = document.createElement("span");
                unit.className = "ntbk-popover-unit";
                unit.textContent = "cm";
                row.append(input, unit);
                panel.appendChild(row);

                const reset = document.createElement("button");
                reset.className = "ntbk-popover-mode";
                reset.style.width = "100%";
                reset.textContent = "Lay it flat (0\u00b0)";
                reset.addEventListener("click", () => {
                  app.ruler.angle = 0;
                  app.ruler.place();
                  close();
                });
                panel.appendChild(reset);

                const hint = document.createElement("div");
                hint.className = "ntbk-popover-hint";
                hint.textContent = "Drag the body to move it, the knob to turn it. "
                  + "Hold Shift while turning for 15\u00b0 steps.";
                panel.appendChild(hint);
              } },
            { label: "Protractor", icon: "triangle-right", disabled: true,
              tooltip: "A standalone protractor \u2014 not built yet" },
            { label: "Compass", icon: "circle-dashed", disabled: true,
              tooltip: "For constructions \u2014 not built yet" },
          ],
        },
      ],
    },
    {
      name: "Insert",
      groups: [
        {
          name: "Maths",
          items: [
            { label: "LaTeX", icon: "sigma", action: (a) => a.insertLatex() },
            { label: "Plot", icon: "chart-line",
              tooltip: "Plot y = f(x) — double-click a plot to edit it",
              action: (a) => a.insertGraph("function2d"),
              menu: (app, panel, close) => {
                for (const [label, kind, hint] of [
                  ["2D function", "function2d", "y = f(x), several curves at once"],
                  ["3D surface", "surface3d", "z = f(x, y), rotatable"],
                  ["Statistics", "stats", "Bar, line or box plot from data"],
                ]) {
                  const button = document.createElement("button");
                  button.className = "ntbk-popover-mode";
                  button.style.width = "100%";
                  button.style.marginBottom = "4px";
                  button.textContent = label;
                  button.title = hint;
                  button.addEventListener("click", () => { close(); app.insertGraph(kind); });
                  panel.appendChild(button);
                }
                const geometry = document.createElement("button");
                geometry.className = "ntbk-popover-mode";
                geometry.style.width = "100%";
                geometry.textContent = "Geometry";
                geometry.disabled = true;
                geometry.title = "Needs its own construction UI — not built yet";
                panel.appendChild(geometry);

                const hint = document.createElement("div");
                hint.className = "ntbk-popover-hint";
                hint.textContent = "All four run on JSXGraph.";
                panel.appendChild(hint);
              } },
            { label: "Simulate", icon: "atom", disabled: true,
              tooltip: "Physics simulation — matter.js is installed, not wired up yet" },
          ],
        },
        {
          name: "Content",
          items: [
            { label: "Picture", icon: "image",
              tooltip: "Insert an image — or just paste or drop one on the canvas",
              action: (a) => a.insertImage() },
            { label: "PDF", icon: "file-type-2",
              tooltip: "Insert PDF pages as a printout",
              action: (a) => a.insertPdf() },
            { label: "Table", icon: "table", disabled: true, tooltip: "Not in phase 1" },
            { label: "Code", icon: "code",
              tooltip: "A code cell — the filename picks the language",
              action: (a) => a.insertCode("untitled.py"),
              menu: (app, panel, close) => {
                const table = app.languages ?? {};
                const entries = Object.entries(table)
                  .filter(([, v]) => v.available)
                  .sort((a, b) => a[1].name.localeCompare(b[1].name));

                for (const [extension, info] of entries) {
                  const button = document.createElement("button");
                  button.className = "ntbk-popover-mode";
                  button.style.width = "100%";
                  button.style.marginBottom = "3px";
                  button.textContent = `${info.name}  ${extension}`;
                  button.addEventListener("click", () => {
                    close();
                    app.insertCode(extension === ".java" ? "Main.java" : `untitled${extension}`);
                  });
                  panel.appendChild(button);
                }

                const missing = Object.values(table).filter((v) => !v.available);
                const hint = document.createElement("div");
                hint.className = "ntbk-popover-hint";
                hint.textContent = missing.length
                  ? `${missing.length} more once installed: ${
                      [...new Set(missing.map((m) => m.probe))].join(", ")}`
                  : "Rename a cell to change language.";
                panel.appendChild(hint);
              } },
          ],
        },
      ],
    },
  ];
}
