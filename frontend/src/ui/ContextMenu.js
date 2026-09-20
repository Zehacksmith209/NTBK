// ─────────────────────────────────────────────
//  PROPERTIES MENU
//
//  Right-click (or two-finger click) on anything
//  selected: rotate, flip, recolour, re-thicken,
//  delete. Everything here goes through the
//  history, so every item is undoable.
// ─────────────────────────────────────────────
import { typeableReadout } from "./NumberField.js";

const SWATCHES = [
  "#111111", "#1a6ef5", "#c62828", "#2e7d32",
  "#f57c00", "#6a1b9a", "#00838f", "#777777",
];

let open = null;

export function closeContextMenu() {
  open?.remove();
  open = null;
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("keydown", onEscape, true);
}

function onOutside(event) {
  if (open && !open.contains(event.target)) closeContextMenu();
}

function onEscape(event) {
  if (event.key === "Escape") closeContextMenu();
}

export function openContextMenu(app, clientX, clientY) {
  closeContextMenu();

  const strokes = app.selectedStrokes();
  const hasStrokes = strokes.length > 0;
  const count = app.selection.size;

  const menu = document.createElement("div");
  menu.className = "ntbk-context";

  const heading = document.createElement("div");
  heading.className = "ntbk-context-head";
  heading.textContent = count === 1 ? "1 item selected" : `${count} items selected`;
  menu.appendChild(heading);

  const row = (label) => {
    const el = document.createElement("div");
    el.className = "ntbk-context-row";
    if (label) {
      const span = document.createElement("span");
      span.className = "ntbk-context-label";
      span.textContent = label;
      el.appendChild(span);
    }
    menu.appendChild(el);
    return el;
  };

  const button = (parent, text, title, action, disabled = false) => {
    const el = document.createElement("button");
    el.className = "ntbk-context-btn";
    el.textContent = text;
    el.title = title;
    el.disabled = disabled;
    el.addEventListener("click", () => { action(); closeContextMenu(); });
    parent.appendChild(el);
    return el;
  };

  // ── Rotate ──
  const rotate = row("Rotate");
  button(rotate, "↺ 90°", "Rotate 90° anticlockwise", () => app.rotateSelection(-90));
  button(rotate, "↺ 45°", "Rotate 45° anticlockwise", () => app.rotateSelection(-45));
  button(rotate, "↻ 45°", "Rotate 45° clockwise", () => app.rotateSelection(45));
  button(rotate, "↻ 90°", "Rotate 90° clockwise", () => app.rotateSelection(90));

  // ── Flip ──
  const flip = row("Flip");
  button(flip, "⇆ Horizontal", "Mirror left to right", () => app.flipSelection("x"));
  button(flip, "⇅ Vertical", "Mirror top to bottom", () => app.flipSelection("y"));

  // ── Colour, strokes only ──
  const colour = row("Colour");
  if (hasStrokes) {
    for (const value of SWATCHES) {
      const dot = document.createElement("button");
      dot.className = "ntbk-context-swatch";
      dot.style.background = value;
      dot.title = value;
      dot.addEventListener("click", () => {
        app.applyStyle("pen", { color: value });
        closeContextMenu();
      });
      colour.appendChild(dot);
    }
  } else {
    const note = document.createElement("span");
    note.className = "ntbk-context-note";
    note.textContent = "ink only";
    colour.appendChild(note);
  }

  // ── Thickness, strokes only ──
  const thickness = row("Thickness");
  if (hasStrokes) {
    const current = app.store.find(strokes[0])?.style?.size ?? 3;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.5";
    slider.max = "40";
    slider.step = "0.5";
    slider.value = current;
    const output = document.createElement("output");
    output.textContent = current;
    // Live while dragging, one history entry when you let go
    slider.addEventListener("input", () => {
      app.previewStyle({ size: Number(slider.value) });
    });
    slider.addEventListener("change", () => {
      app.applyStyle("pen", { size: Number(slider.value) });
    });
    thickness.appendChild(slider);
    thickness.appendChild(output);
    typeableReadout(slider, output, { decimals: 1 });
  } else {
    const note = document.createElement("span");
    note.className = "ntbk-context-note";
    note.textContent = "ink only";
    thickness.appendChild(note);
  }

  // ── Layer ──
  const layers = app.store.data.canvas.layers ?? [];
  if (layers.length > 1) {
    const layerRow = row("Layer");
    const select = document.createElement("select");
    select.className = "ntbk-context-select";
    for (const layer of layers) {
      const option = document.createElement("option");
      option.value = layer.id;
      option.textContent = layer.name;
      select.appendChild(option);
    }
    // Where the selection sits now — blank when it straddles two layers, so
    // the box never claims a layer the selection isn't wholly on
    const on = new Set([...app.selection].map((id) => app.store.find(id)?.layerId));
    select.value = on.size === 1 ? [...on][0] : "";
    select.addEventListener("change", () => {
      app.moveSelectionToLayer(select.value);
      closeContextMenu();
    });
    layerRow.appendChild(select);
  }

  const last = row("");
  last.classList.add("ntbk-context-danger");
  button(last, "Delete", "Remove from the page", () => app.deleteSelection());

  document.body.appendChild(menu);
  open = menu;

  // Keep it on screen when opened near an edge
  const rect = menu.getBoundingClientRect();
  const x = Math.min(clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("keydown", onEscape, true);
  }, 0);
  return menu;
}
