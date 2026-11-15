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

  // ── Knowledge graph ──
  //
  // Deliberately here, on the canvas, in the same gesture as selecting.
  // The alternative — open panel, press New Node, then go back and find the
  // region — is the sequence that kills this kind of feature: nobody keeps a
  // graph up to date if capturing costs four steps and a context switch.
  if (count > 0) {
    const graphRow = row("Graph");
    button(graphRow, "+ Add to graph…", "Make this region a place a concept lives",
      () => openGraphCapture(app, clientX, clientY));

    // Only once this selection IS a concept. Offering "link" before there is
    // anything to link from would be a dead control, and a menu that shows
    // options you cannot use teaches people to stop reading it.
    const already = app.knowledge?.nodesForSelection([...app.selection]) ?? [];
    if (already.length) {
      const linkRow = row("");
      const name = already.length === 1 ? already[0].label : `${already.length} concepts`;
      button(linkRow, `⇢ Link ${name}…`, "Say what this concept needs first",
        () => openGraphLink(app, already, clientX, clientY));
    }
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


// ─────────────────────────────────────────────
//  CAPTURE
//
//  One small popover: name a new concept, or
//  attach this region to one that exists.
// ─────────────────────────────────────────────
let capture = null;

export function closeGraphCapture() {
  capture?.remove();
  capture = null;
}

function openGraphCapture(app, clientX, clientY) {
  closeGraphCapture();
  const graph = app.knowledge;
  if (!graph) return;

  const ids = [...app.selection];
  const bounds = app.selectionController.boundsOf(ids);
  if (!bounds) return;

  // Split the selection the way the model stores it. Strokes matter as much
  // as objects: a worked example is usually pure ink, and an anchor that
  // tracked only objects could not follow the content it was drawn around.
  const objectIds = [], strokeIds = [];
  for (const id of ids) {
    const element = app.store.find(id);
    if (!element) continue;
    (element.kind ? strokeIds : objectIds).push(id);
  }
  const box = { x: bounds.minX, y: bounds.minY,
                w: bounds.maxX - bounds.minX, h: bounds.maxY - bounds.minY };

  const panel = document.createElement("div");
  panel.className = "ntbk-context ntbk-capture";
  panel.innerHTML = `<div class="ntbk-context-head">Add to graph</div>`;

  const field = document.createElement("input");
  field.className = "ntbk-capture-input";
  field.type = "text";
  field.placeholder = "Concept name";
  field.spellcheck = false;
  panel.appendChild(field);

  const hits = document.createElement("div");
  hits.className = "ntbk-capture-hits";
  panel.appendChild(hits);

  const finish = (nodeId) => {
    app.knowledge.addAnchor(nodeId, box, { objectIds, strokeIds });
    app.knowledge.select(nodeId);
    app.openGraphPanel?.();
    closeGraphCapture();
    closeContextMenu();
  };

  const draw = () => {
    const query = field.value.trim();
    hits.innerHTML = "";

    // Creating is the common case, so it is the first row and Enter does it.
    if (query) {
      const exact = graph.graph.nodes.find(
        (n) => n.label.toLowerCase() === query.toLowerCase());
      if (!exact) {
        const make = document.createElement("button");
        make.className = "ntbk-context-btn ntbk-capture-new";
        make.textContent = `Create “${query}”`;
        make.addEventListener("click", () => {
          const node = app.knowledge.captureAs(query, box, { objectIds, strokeIds });
          if (node) { app.knowledge.select(node.id); app.openGraphPanel?.(); }
          closeGraphCapture();
          closeContextMenu();
        });
        hits.appendChild(make);
      }
    }

    for (const hit of graph.search(query).slice(0, 6)) {
      const node = graph.node(hit.id);
      if (!node) continue;
      const item = document.createElement("button");
      item.className = "ntbk-context-btn";
      const where = graph.anchorsOf(node.id).length;
      item.textContent = where ? `${node.label}  ·  ${where} region${where === 1 ? "" : "s"}`
                               : node.label;
      item.title = "Attach this region to an existing concept";
      item.addEventListener("click", () => finish(node.id));
      hits.appendChild(item);
    }

    if (!hits.children.length) {
      const note = document.createElement("div");
      note.className = "ntbk-context-note";
      note.textContent = "Type a name to create your first concept";
      hits.appendChild(note);
    }
  };

  field.addEventListener("input", draw);
  field.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") { closeGraphCapture(); return; }
    if (event.key === "Enter") hits.querySelector("button")?.click();
  });
  draw();

  document.body.appendChild(panel);
  capture = panel;
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${Math.min(clientX, window.innerWidth - rect.width - 10)}px`;
  panel.style.top = `${Math.min(clientY, window.innerHeight - rect.height - 10)}px`;
  field.focus();

  setTimeout(() => document.addEventListener("pointerdown", function away(event) {
    if (capture && !capture.contains(event.target)) {
      closeGraphCapture();
      document.removeEventListener("pointerdown", away, true);
    }
  }, true), 0);
}


/**
 * Link a concept the selection already belongs to, to another one.
 *
 * Reached from the canvas rather than the panel because that is where the
 * student is when they notice the connection — "oh, this needs the product
 * rule" is a thought you have while looking at the working, not while
 * browsing a list.
 */
function openGraphLink(app, sources, clientX, clientY) {
  closeGraphCapture();
  const graph = app.knowledge;

  const panel = document.createElement("div");
  panel.className = "ntbk-context ntbk-capture";
  const from = sources.length === 1 ? sources[0].label : `${sources.length} concepts`;
  panel.innerHTML = `<div class="ntbk-context-head">${from} needs first…</div>`;

  const field = document.createElement("input");
  field.className = "ntbk-capture-input";
  field.type = "text";
  field.placeholder = "Search concepts";
  field.spellcheck = false;
  panel.appendChild(field);

  const hits = document.createElement("div");
  hits.className = "ntbk-capture-hits";
  panel.appendChild(hits);

  const sourceIds = new Set(sources.map((n) => n.id));
  const draw = () => {
    hits.innerHTML = "";
    const found = graph.search(field.value.trim())
      .map((h) => graph.node(h.id))
      .filter((n) => n && !sourceIds.has(n.id))
      .slice(0, 7);

    for (const other of found) {
      const item = document.createElement("button");
      item.className = "ntbk-context-btn";
      item.textContent = other.label;
      item.title = `${from} needs ${other.label} first`;
      item.addEventListener("click", () => {
        for (const source of sources) graph.linkNodes(other.id, source.id, "prerequisite");
        graph.select(sources[0].id);
        app.openGraphPanel?.();
        closeGraphCapture();
        closeContextMenu();
      });
      hits.appendChild(item);
    }
    if (!found.length) {
      const note = document.createElement("div");
      note.className = "ntbk-context-note";
      note.textContent = graph.graph.nodes.length > sources.length
        ? "Nothing matches that." : "No other concepts yet.";
      hits.appendChild(note);
    }
  };

  field.addEventListener("input", draw);
  field.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") closeGraphCapture();
    if (event.key === "Enter") hits.querySelector("button")?.click();
  });
  draw();

  document.body.appendChild(panel);
  capture = panel;
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${Math.min(clientX, window.innerWidth - rect.width - 10)}px`;
  panel.style.top = `${Math.min(clientY, window.innerHeight - rect.height - 10)}px`;
  field.focus();

  setTimeout(() => document.addEventListener("pointerdown", function away(event) {
    if (capture && !capture.contains(event.target)) {
      closeGraphCapture();
      document.removeEventListener("pointerdown", away, true);
    }
  }, true), 0);
}
