import { computePosition, offset, flip, shift } from "@floating-ui/dom";
import { createIcons, icons } from "lucide";
import Pickr from "@simonwep/pickr";
import { typeableReadout } from "./NumberField.js";
import { bridge } from "../bridge.js";
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
  // The theme button relabels itself, so it has to be findable after a rebuild
  if (item.themeToggle) button.dataset.themeToggle = "";
  // The button itself is passed so an item can open a popover anchored to it,
  // without needing a caret of its own.
  button.addEventListener("click", () => item.action?.(app, button));
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

  // Lives on the search row, as a peer of the filter: both are ways of
  // narrowing what you are looking at.
  const folderButton = document.createElement("button");
  folderButton.className = "ntbk-shape-folder";
  folderButton.innerHTML = `<i data-lucide="folder"></i>`;
  folderButton.title = "Read shapes from a different folder";
  search.appendChild(folderButton);
  panel.appendChild(search);

  // Which folder the list came from. Worth the line: once this can be moved,
  // "my shape is missing" and "I am looking in the wrong place" are the same
  // symptom, and only this tells them apart.
  const where = document.createElement("div");
  where.className = "ntbk-shape-where";
  panel.appendChild(where);

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

  // Rebuildable, because pointing the library at another folder replaces the
  // whole list — including going from empty to populated, which a one-shot
  // build could not express: the "None yet" branch returned before the search
  // box was ever wired up, so a folder with shapes in it stayed unsearchable.
  let shapes = [];

  const draw = (query) => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? shapes.filter((entry) => entry.name.toLowerCase().includes(needle))
      : shapes;
    list.innerHTML = "";

    if (!shapes.length) {
      const empty = document.createElement("div");
      empty.className = "ntbk-popover-hint";
      empty.textContent = "Nothing in this folder. Draw something, select it, then save it.";
      list.appendChild(empty);
      return [];
    }
    if (!matches.length) {
      const none = document.createElement("div");
      none.className = "ntbk-popover-hint";
      none.textContent = `Nothing matches "${query.trim()}"`;
      list.appendChild(none);
      return [];
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

  /** Reload the library and repaint, after opening or after a folder change. */
  const refresh = async () => {
    shapes = await app.loadShapes();
    const folder = await bridge.shapeFolder();
    // The home directory is noise in a narrow panel; the tail is the part
    // that tells you which folder this is.
    where.textContent = folder ? folder.replace(/^\/Users\/[^/]+/, "~") : "";
    where.title = folder;
    draw(searchInput.value);
  };

  folderButton.addEventListener("click", async () => {
    const result = await bridge.chooseShapeFolder();
    if (result?.cancelled) return;
    if (!result?.ok) {
      where.textContent = result?.error ?? "Could not open that folder";
      return;
    }
    searchInput.value = "";      // a filter from the old folder means nothing here
    await refresh();
  });

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

  refresh();
}

// ── Theme ───────────────────────────────────
//
//  Only the chrome changes. The page, plots and
//  imported PDF pages stay light, because they
//  are the things that get written into an
//  exported PDF — see the dark block in app.css.

/** Paint a theme and swap the button's icon to show what clicking does next. */
export function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.title = dark ? "Switch to light mode" : "Switch to dark mode";
    const icon = button.querySelector("i, svg");
    if (icon) {
      const fresh = document.createElement("i");
      fresh.setAttribute("data-lucide", dark ? "sun" : "moon");
      icon.replaceWith(fresh);
      createIcons({ icons, root: button });
    }
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  bridge.setTheme(next);
}

/** Read the remembered theme and paint it. Called once at startup. */
export async function restoreTheme() {
  // localStorage first: it answers immediately, so the window does not flash
  // white before the Python bridge replies. The file is the durable record.
  let theme = null;
  try { theme = localStorage.getItem("ntbk-theme"); } catch { /* private mode */ }
  if (theme === "dark" || theme === "light") applyTheme(theme);
  const stored = await bridge.getTheme();
  if (stored !== theme) applyTheme(stored);
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

// How strongly pressure drives width when the switch is on. Kept here so
// turning pressure off and on again restores the tuned value rather than
// whatever the stroke happened to carry.
const PEN_THINNING = 0.6;

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

    // Only the pen responds to pressure. A highlighter is a marker: constant
    // width is what makes it look like one, so it gets no switch.
    if (kind === "pen") {
      const pressureRow = document.createElement("div");
      pressureRow.className = "ntbk-popover-row";
      pressureRow.innerHTML = `
        <label>Pressure</label>
        <span class="ntbk-switch"><input type="checkbox"></span>`;
      panel.appendChild(pressureRow);

      const note = document.createElement("div");
      note.className = "ntbk-popover-row is-note";
      note.innerHTML = `<small></small>`;
      panel.appendChild(note);

      const toggle = pressureRow.querySelector("input");
      toggle.checked = (settings.thinning ?? 0) > 0;
      const describe = () => {
        // Deliberately does NOT promise anything for a mouse. perfect-freehand
        // fakes pressure from the GAP between samples, and thinning the line
        // normalises those gaps away, so a mouse gets a near-constant width
        // whatever the switch says. Better to name the requirement than to
        // claim a behaviour the app does not actually have.
        note.querySelector("small").textContent = toggle.checked
          ? "Line varies with how hard you press. Needs a pressure-sensitive pen."
          : "Line keeps one width the whole way.";
      };
      describe();
      toggle.addEventListener("change", () => {
        // Thinning IS the pressure response — at 0 perfect-freehand skips the
        // pressure path entirely and every point gets size/2.
        app.applyStyle(kind, { thinning: toggle.checked ? PEN_THINNING : 0 });
        describe();
      });
    }

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
            { label: "Companion", icon: "tablet-smartphone",
              tooltip: "Write on a tablet over your own Wi-Fi \u2014 off until you turn it on",
              action: (a) => openCompanionDialog(a) },
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
            { label: "Theme", icon: "moon", themeToggle: true,
              tooltip: "Switch to dark mode", action: () => toggleTheme() },
            { label: "Cursor", icon: "crosshair",
              tooltip: "Fix a stylus that draws away from where the pen is",
              action: (a, el) => openMenu(a, el, cursorMenu) },
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
            { id: "protractor", label: "Protractor", icon: "triangle-right",
              tooltip: "Measure an angle, or set one and draw along it",
              action: (a) => a.toggleProtractor(),
              menu: (app, panel, close) => {
                panel.style.width = "250px";
                const numberRow = (label, value, unit, min, max, step, apply) => {
                  const row = document.createElement("div");
                  row.className = "ntbk-popover-row";
                  const caption = document.createElement("label");
                  caption.textContent = label;
                  const input = document.createElement("input");
                  input.type = "number";
                  input.className = "ntbk-number";
                  Object.assign(input, { min, max, step, value });
                  input.addEventListener("change", () => apply(Number(input.value)));
                  input.addEventListener("keydown", (event) => event.stopPropagation());
                  const suffix = document.createElement("span");
                  suffix.className = "ntbk-popover-unit";
                  suffix.textContent = unit;
                  row.append(caption, input, suffix);
                  panel.appendChild(row);
                };
                numberRow("Angle", String(app.protractor.arm), "\u00b0", "0", "180", "0.5", (value) => {
                  if (!app.protractor.visible) app.toggleProtractor();
                  app.protractor.setArm(value);
                });
                numberRow("Radius", String(app.protractor.radiusCm), "cm", "3", "15", "0.5",
                  (value) => app.protractor.setRadius(value));

                const flat = document.createElement("button");
                flat.className = "ntbk-popover-mode";
                flat.style.width = "100%";
                flat.textContent = "Lay it flat (0\u00b0)";
                flat.addEventListener("click", () => {
                  app.protractor.angle = 0;
                  app.protractor.place();
                  close();
                });
                panel.appendChild(flat);

                const hint = document.createElement("div");
                hint.className = "ntbk-popover-hint";
                hint.textContent = "Put the cross on the corner. Drag the blue knob to "
                  + "set the angle, then draw along the arm. Shift gives 15\u00b0 steps.";
                panel.appendChild(hint);
              } },
            { id: "compass", label: "Compass", icon: "circle-dashed",
              tooltip: "Draw circles and arcs about a point",
              action: (a) => a.toggleCompass(),
              menu: (app, panel, close) => {
                panel.style.width = "250px";
                const row = document.createElement("div");
                row.className = "ntbk-popover-row";
                const caption = document.createElement("label");
                caption.textContent = "Radius";
                const input = document.createElement("input");
                input.type = "number";
                input.className = "ntbk-number";
                Object.assign(input, { min: "0.1", max: "40", step: "0.1",
                                       value: app.compass.radiusCm.toFixed(1) });
                input.addEventListener("change", () => {
                  if (!app.compass.visible) app.toggleCompass();
                  app.compass.setRadiusCm(Number(input.value));
                });
                input.addEventListener("keydown", (event) => event.stopPropagation());
                const unit = document.createElement("span");
                unit.className = "ntbk-popover-unit";
                unit.textContent = "cm";
                row.append(caption, input, unit);
                panel.appendChild(row);

                const whole = document.createElement("button");
                whole.className = "ntbk-popover-mode";
                whole.style.width = "100%";
                whole.textContent = "Draw the full circle";
                whole.addEventListener("click", () => {
                  app.compass.setRadiusCm(Number(input.value));
                  app.compass.drawCircle();
                  app._syncRulerButton();
                  close();
                });
                panel.appendChild(whole);

                const hint = document.createElement("div");
                hint.className = "ntbk-popover-hint";
                hint.textContent = "Drag the ring to move it, the square to open or close "
                  + "it, and the pencil dot to draw. It draws in the pen\u2019s colour.";
                panel.appendChild(hint);
              } },
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
            { id: "formulas", label: "Formulas", icon: "book-open",
              tooltip: "Your formula library \u2014 insert one as LaTeX, or put values into it",
              action: (a) => a.toggleFormulaLibrary() },
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
            { label: "Video", icon: "video",
              tooltip: "Play a YouTube or other online video on the page",
              action: (a, el) => openMenu(a, el, videoMenu) },
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


/* ── Companion mode dialog ───────────────────
   Shows the address and the code, and nothing else. Off by default and
   started only from here, so nothing about this is discoverable by accident. */
let companionBox = null;

export function closeCompanionDialog() {
  companionBox?.remove();
  companionBox = null;
}

async function openCompanionDialog(app) {
  closeCompanionDialog();
  const box = document.createElement("div");
  box.className = "ntbk-companion-dialog";
  box.innerHTML = `
    <div class="ntbk-companion-head">
      <strong>Companion mode</strong>
      <button class="ntbk-graph-x" data-close>\u00d7</button>
    </div>
    <div class="ntbk-companion-body">Starting\u2026</div>`;
  document.body.appendChild(box);
  companionBox = box;
  box.querySelector("[data-close]").addEventListener("click", closeCompanionDialog);

  const body = box.querySelector(".ntbk-companion-body");
  const info = await app.startCompanion();
  if (!info?.running) {
    // Say WHY. "Could not start" tells a student nothing they can act on,
    // and this whole feature is built on never failing silently.
    const why = document.createElement("p");
    why.className = "ntbk-companion-bad";
    why.textContent = info?.error
      ? info.error
      : "Could not start the server, and it gave no reason.";
    body.innerHTML = "";
    body.appendChild(why);
    return;
  }

  body.innerHTML = `
    <p>On your tablet, open Safari and go to:</p>
    <div class="ntbk-companion-url"></div>
    <p>Then enter this code:</p>
    <div class="ntbk-companion-code"></div>
    <p class="ntbk-companion-note">
      Both devices must be on the same Wi\u2011Fi. Many university networks
      block devices from seeing each other \u2014 if the address does not load,
      that is usually why. A phone hotspot with both devices joined works.
    </p>
    <button class="ntbk-mini" data-stop>Turn off</button>`;
  body.querySelector(".ntbk-companion-url").textContent = info.url;
  body.querySelector(".ntbk-companion-code").textContent = info.code;
  body.querySelector("[data-stop]").addEventListener("click", async () => {
    await app.stopCompanion();
    closeCompanionDialog();
  });
}


/* ── Cursor calibration ──────────────────────
   For a display stack that reports the stylus in the wrong place. Sidecar
   does this intermittently and the app cannot detect it: by the time the
   event arrives the coordinates are simply wrong.

   Zero is the app's original behaviour and the reference this returns to.
   It is never changed by anything but an explicit edit here. */
function cursorMenu(app, panel) {
  panel.classList.add("ntbk-cursor-menu");

  const head = document.createElement("div");
  head.className = "ntbk-popover-hint";
  head.style.borderTop = "none";
  head.style.paddingTop = "0";
  head.textContent = "If your ink lands away from the pen, nudge it back.";
  panel.appendChild(head);

  const modes = document.createElement("div");
  modes.className = "ntbk-popover-modes";
  panel.appendChild(modes);

  const rows = {};
  for (const axis of ["x", "y"]) {
    const row = document.createElement("div");
    row.className = "ntbk-popover-row";
    row.innerHTML = `<label>${axis.toUpperCase()}</label>
      <input type="range" min="-200" max="200" step="1" value="0">
      <output>0</output>`;
    panel.appendChild(row);
    rows[axis] = { range: row.querySelector("input"), out: row.querySelector("output") };
  }

  const note = document.createElement("div");
  note.className = "ntbk-popover-hint";
  note.textContent = "Positive moves the ink right and down. "
    + "Zero is the app\u2019s normal behaviour.";
  panel.appendChild(note);

  let saved = { x: 0, y: 0 };

  const show = (offset) => {
    for (const axis of ["x", "y"]) {
      rows[axis].range.value = offset[axis];
      rows[axis].out.textContent = Math.round(offset[axis]);
    }
    const zero = !offset.x && !offset.y;
    modes.children[0]?.classList.toggle("is-active", zero);
    modes.children[1]?.classList.toggle("is-active", !zero);
  };

  const apply = (offset, remember) => {
    // The scene reads this on every conversion, so it takes effect on the
    // next stroke without a reload.
    app.scene.pointerOffset = { x: offset.x, y: offset.y };
    bridge.setPointerOffset(offset.x, offset.y, remember).then((state) => {
      saved = state.saved ?? saved;
    });
    show(offset);
  };

  for (const [label, title, get] of [
    ["System Original", "Trust the operating system — the app\u2019s normal behaviour",
      () => ({ x: 0, y: 0 })],
    ["Reinforced Coordinates", "Use the correction you set up",
      () => ({ ...saved })],
  ]) {
    const button = document.createElement("button");
    button.className = "ntbk-popover-mode";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", () => {
      const next = get();
      // Switching to System Original must not erase the numbers the student
      // worked out, or the toggle is one-way.
      apply(next, false);
    });
    modes.appendChild(button);
  }

  for (const axis of ["x", "y"]) {
    const { range, out } = rows[axis];
    range.addEventListener("input", () => {
      out.textContent = range.value;
      apply({ x: Number(rows.x.range.value), y: Number(rows.y.range.value) }, true);
    });
    typeableReadout(range, out, { decimals: 0 });
  }

  bridge.pointerOffset().then((state) => {
    saved = state.saved ?? { x: 0, y: 0 };
    app.scene.pointerOffset = { ...state.active };
    show(state.active);
  });
}


/* ── Insert video ────────────────────────────
   One box for the address. Enter inserts. */
function videoMenu(app, panel, close) {
  panel.classList.add("ntbk-video-menu");
  const field = document.createElement("input");
  field.type = "url";
  field.className = "ntbk-capture-input";
  field.placeholder = "Paste a video link";
  field.spellcheck = false;
  panel.appendChild(field);

  const go = document.createElement("button");
  go.className = "ntbk-popover-mode";
  go.style.width = "100%";
  go.textContent = "Insert video";
  panel.appendChild(go);

  const hint = document.createElement("div");
  hint.className = "ntbk-popover-hint";
  const usual = "YouTube (videos and Shorts), Vimeo, Dailymotion, TikTok, "
    + "Instagram reels, or a direct .mp4 link. Needs an internet connection.";
  hint.textContent = usual;
  panel.appendChild(hint);

  const insert = () => {
    const url = field.value.trim();
    if (!url) { field.focus(); return; }
    if (app.insertVideo(url)) { close(); return; }
    hint.textContent = "That does not look like a link.";
    hint.classList.add("is-bad");
  };
  go.addEventListener("click", insert);
  field.addEventListener("input", () => {
    hint.textContent = usual;
    hint.classList.remove("is-bad");
  });
  field.addEventListener("keydown", (event) => {
    event.stopPropagation();          // never let typing reach the canvas
    if (event.key === "Enter") insert();
    if (event.key === "Escape") close();
  });
  setTimeout(() => field.focus(), 0);
}
