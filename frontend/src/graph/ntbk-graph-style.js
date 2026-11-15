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
  cy.on("mouseover", "node", (e) => e.target.addClass("hover"));
  cy.on("mouseout", "node", (e) => e.target.removeClass("hover"));

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
