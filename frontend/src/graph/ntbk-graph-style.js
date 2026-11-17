/* ------------------------------------------------------------------
   ntbk — knowledge graph styling for Cytoscape.js

   Token mapping (this app's names, not the draft's):
     --ntbk-ink      -> --text
     --ntbk-ink-2    -> --text-dim
     --ntbk-surface  -> --desk-b   (the graph canvas colour, so the label
                                    chip blends into the background rather
                                    than sitting on a panel-coloured slab)
     --ntbk-border   -> --line
     --ntbk-accent   -> --accent
     --ntbk-font-ui  -> --font

   Read at call time, never cached: the style array is built from computed
   values, so it has to be rebuilt when the theme changes.
   ------------------------------------------------------------------ */

function tok(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Colour by group.
 *
 * The draft hardcoded maths/physics/chem/eng. This app's `group` is free
 * text the student types, so the palette is assigned per distinct group in a
 * stable order instead — same idea, but it works for "thermo" and "paper 2".
 */
export const GROUP_PALETTE = [
  "#2D6CA8", "#8C5BA8", "#3F8F6B", "#B0722A",
  "#A8455B", "#2F7D8C", "#6B6F2A", "#5B6472",
];

export function groupColours(groups) {
  const map = new Map();
  groups.forEach((g, i) => map.set(g, GROUP_PALETTE[i % GROUP_PALETTE.length]));
  return map;
}

export function graphStyle(groups = []) {
  const ink     = tok("--text", "#1A1E21");
  const ink2    = tok("--text-dim", "#5B646B");
  const surface = tok("--desk-b", "#FFFFFF");
  const line    = tok("--line", "#CFD5DA");
  const accent  = tok("--accent", "#2D6CA8");
  const font    = tok("--font", 'system-ui, -apple-system, "Segoe UI", sans-serif');
  const still   = reducedMotion();

  const motion = still ? {} : {
    "transition-property":
      "background-opacity border-width border-color opacity width height",
    "transition-duration": "140ms",
    "transition-timing-function": "ease-out",
  };

  const style = [
    {
      selector: "node",
      style: {
        "background-color": accent,
        "background-opacity": 0.14,       // soft fill…
        "border-width": 1.5,
        "border-color": accent,
        "border-opacity": 1,              // …plus a crisp ring

        // size encodes how many places the concept appears
        "width": "data(size)",
        "height": "data(size)",
        "shape": "ellipse",

        "label": "data(label)",
        "font-family": font,
        "font-size": 11,
        "font-weight": 500,
        "color": ink,
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 6,
        "text-wrap": "wrap",
        "text-max-width": 110,

        // No black outline. A soft chip behind the text instead.
        "text-outline-width": 0,
        "text-background-color": surface,
        "text-background-opacity": 0.82,
        "text-background-padding": 3,
        "text-background-shape": "roundrectangle",

        "min-zoomed-font-size": 7,        // labels vanish when far out
        "overlay-opacity": 0,             // kill Cytoscape's grey tap blob
        ...motion,
      },
    },
  ];

  for (const [group, colour] of groupColours(groups)) {
    if (!group) continue;
    style.push({
      selector: `node[group = ${JSON.stringify(group)}]`,
      style: { "background-color": colour, "border-color": colour },
    });
  }

  style.push(
    {
      selector: "edge",
      style: {
        "curve-style": "bezier",
        "width": 1.2,
        "line-color": line,
        "line-opacity": 0.9,
        "target-arrow-shape": "none",
        "overlay-opacity": 0,
        ...(still ? {} : {
          "transition-property": "line-color line-opacity width opacity",
          "transition-duration": "140ms",
        }),
      },
    },
    {
      // directed: "you need this before that"
      selector: 'edge[type = "prerequisite"]',
      style: {
        "target-arrow-shape": "triangle",
        "target-arrow-color": ink2,
        "arrow-scale": 0.7,
        "line-color": ink2,
        "line-opacity": 0.55,
        "width": 1.4,
      },
    },
    // ── Kinds of link ──
    // Told apart by line style and colour together, so they still read
    // apart for someone who cannot tell the colours apart.
    { selector: 'edge[type = "derives"]', style: {
        "target-arrow-shape": "triangle", "arrow-scale": 0.7,
        "line-color": "#3F8F6B", "target-arrow-color": "#3F8F6B",
        "line-opacity": 0.8, "width": 1.6 } },
    { selector: 'edge[type = "example"]', style: {
        "target-arrow-shape": "vee", "arrow-scale": 0.8,
        "line-style": "dotted", "line-color": "#B0722A", "target-arrow-color": "#B0722A",
        "line-opacity": 0.85, "width": 1.6 } },
    { selector: 'edge[type = "cites"]', style: {
        "target-arrow-shape": "circle", "arrow-scale": 0.6,
        "line-style": "dashed", "line-dash-pattern": [2, 4],
        "line-color": "#8C5BA8", "target-arrow-color": "#8C5BA8", "line-opacity": 0.8 } },
    { selector: 'edge[type = "contrast"]', style: {
        "line-style": "dashed", "line-dash-pattern": [7, 4],
        "line-color": "#A8455B", "line-opacity": 0.75, "width": 1.4 } },
    // What a link means shows when you are looking at it
    { selector: "edge.lit, edge.hover", style: {
        "label": "data(label)", "font-family": font, "font-size": 9, "color": ink2,
        "text-rotation": "autorotate", "text-background-color": surface,
        "text-background-opacity": 0.85, "text-background-padding": 2 } },
    // Links the page suggests: faint, and clearly not yet the student's own
    { selector: 'edge[type = "suggested"]', style: {
        "line-style": "dashed", "line-dash-pattern": [3, 5], "line-color": accent,
        "line-opacity": 0.6, "width": 1.6, "label": "maybe", "font-size": 9,
        "color": accent, "text-background-color": surface,
        "text-background-opacity": 0.85, "text-background-padding": 2 } },

    // ── Kinds of node ──
    { selector: 'node[kind = "equation"]', style: { "shape": "round-rectangle" } },
    { selector: 'node[kind = "reference"]', style: { "shape": "round-tag" } },
    { selector: 'node[kind = "project"]', style: { "shape": "round-diamond" } },
    // A concept that lives in another notebook: a hollow ring, and a ↗
    { selector: 'node[kind = "external"]', style: {
        "background-opacity": 0, "border-style": "dashed",
        "label": (n) => `${n.data("label")} ↗` } },

    // ── Topic boxes ──
    { selector: 'node[topic = "yes"]', style: {
        "shape": "round-rectangle", "background-color": ink2, "background-opacity": 0.05,
        "border-width": 1, "border-color": line, "border-opacity": 1,
        "label": "data(label)", "text-valign": "top", "text-halign": "center",
        "text-margin-y": -4, "font-size": 10, "font-weight": 600, "color": ink2,
        "text-background-opacity": 0, "padding": 18, "corner-radius": 10 } },

    // A concept carrying a note is worth spotting without opening it
    { selector: 'node[hasNote = "yes"]', style: {
        "border-style": "double", "border-width": 3.5 } },
    { selector: 'edge[note]', style: { "line-style": "solid" } },
    { selector: "node:selected", style: {
        "background-opacity": 0.28, "border-width": 2.5, "z-index": 30 } },
    { selector: "node.hover", style: {
        "background-opacity": 0.24, "border-width": 2 } },
    { selector: ".lit", style: { "opacity": 1, "z-index": 20 } },
    { selector: "edge.lit", style: {
        "line-color": accent, "line-opacity": 1, "width": 2,
        "target-arrow-color": accent } },
    // everything else recedes — this single effect does most of the work
    { selector: ".dim", style: { "opacity": 0.16 } },
    { selector: "node.match", style: {
        "opacity": 1, "border-width": 3, "border-color": accent, "z-index": 25 } },
  );

  return style;
}

/* ------------------------------------------------------------------
   Layout. Small graphs need different settings, or fcose collapses them
   into a straight line across the whole viewport.
   ------------------------------------------------------------------ */
export function layoutFor(nodeCount) {
  const still = reducedMotion();
  if (nodeCount <= 6) {
    return {
      name: "concentric",
      concentric: (n) => n.degree(),
      levelWidth: () => 1,
      minNodeSpacing: 70,
      padding: 80,
      fit: true,
      animate: !still,
      animationDuration: 320,
    };
  }
  return {
    name: "fcose",
    quality: "proof",
    randomize: true,            // without this, small graphs go linear
    animate: !still,
    animationDuration: 420,
    animationEasing: "ease-out",
    fit: true,
    padding: 70,
    idealEdgeLength: 120,
    nodeRepulsion: 6500,
    nodeSeparation: 90,
    gravity: 0.25,
    numIter: 2500,
  };
}

/** Prerequisite-only view reads far better as a hierarchy. */
export const prerequisiteLayout = () => ({
  name: "dagre",
  rankDir: "TB",
  nodeSep: 55,
  rankSep: 90,
  fit: true,
  padding: 70,
  animate: !reducedMotion(),
  animationDuration: 380,
});

/* ------------------------------------------------------------------
   Interactions — hover halo, focus dimming, sane zoom after fit.
   ------------------------------------------------------------------ */
export function wireInteractions(cy, { onFocus } = {}) {
  cy.on("mouseover", "node, edge", (e) => e.target.addClass("hover"));
  cy.on("mouseout", "node, edge", (e) => e.target.removeClass("hover"));

  const clear = () => cy.elements().removeClass("dim lit");

  function focus(node) {
    const near = node.closedNeighborhood();
    cy.elements().addClass("dim").removeClass("lit");
    near.removeClass("dim").addClass("lit");
  }

  cy.on("tap", "node", (e) => onFocus?.(e.target) ?? focus(e.target));
  cy.on("tap", (e) => { if (e.target === cy) { clear(); onFocus?.(null); } });

  cy.on("dbltap", "node", (e) => {
    cy.animate({ center: { eles: e.target }, zoom: 1.1 },
               { duration: reducedMotion() ? 0 : 260, easing: "ease-out" });
  });

  // stop three nodes rendering either microscopic or sprawled edge to edge
  cy.on("layoutstop", () => {
    if (cy.zoom() > 1.6) {
      cy.zoom({ level: 1.6,
                renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    }
  });

  return { clear, focus };
}

/** Size from anchor count: 22px for one place, up to 46px for eight or more. */
export const sizeForAnchors = (count) => 22 + Math.min(count || 1, 8) * 3;
