// ─────────────────────────────────────────────
//  INSTRUMENTS
//
//  The ruler and the protractor both take the
//  nib when it comes close. The pen asks this
//  one thing rather than each of them, so it
//  does not have to know what is on the page.
// ─────────────────────────────────────────────
export class Instruments {
  constructor(list) {
    this.list = list;
    this.owner = null;
  }

  beginSnap() {
    this.owner = null;
    for (const instrument of this.list) instrument.beginSnap?.();
  }

  endSnap() {
    this.owner = null;
    for (const instrument of this.list) instrument.endSnap?.();
  }

  /**
   * The point, moved onto an edge if one is close enough.
   *
   * Whichever instrument takes a stroke first keeps it to the end. Without
   * that, a line ruled along the ruler would jump onto the protractor the
   * moment it passed near it.
   */
  snap(point) {
    const asked = this.owner ? [this.owner] : this.list;
    for (const instrument of asked) {
      const result = instrument.snap?.(point);
      if (result?.snapped) {
        this.owner = instrument;
        return result;
      }
    }
    return point;
  }

  /** Is the paper here covered by something the nib cannot go through? */
  blocks(point) {
    return this.list.some((instrument) => instrument.blocks?.(point));
  }

  /** Everything that is out, for the moments nothing may be (printing). */
  get out() {
    return this.list.filter((instrument) => instrument.visible);
  }
}

/** Screen pixels within which an edge takes the pen. */
export const SNAP_DISTANCE = 18;

const SVG = "http://www.w3.org/2000/svg";

/** An SVG element with its attributes set, appended to `parent` if given. */
export function svg(tag, attributes = {}, parent = null) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  parent?.appendChild(node);
  return node;
}

/**
 * Drag handling shared by the instruments' handles.
 *
 * `handlers[name]` is called as `start(point, event)` and may return a
 * function to be called with each later point; `end` runs when the drag does.
 */
export function wireHandles(el, app, handlers) {
  // An instrument is never drawn on or selected through its handles
  for (const type of ["pointerdown", "pointermove", "pointerup", "dblclick"]) {
    el.addEventListener(type, (event) => {
      if (event.target.closest?.("[data-grip]")) event.stopPropagation();
    });
  }

  let drag = null;
  el.addEventListener("pointerdown", (event) => {
    const target = event.target.closest?.("[data-grip]");
    const handler = handlers[target?.dataset.grip];
    if (!handler || event.button !== 0) return;
    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    const point = app.scene.toScene(event.clientX, event.clientY);
    drag = { target, ...handler(point, event) };
  });
  el.addEventListener("pointermove", (event) => {
    if (!drag?.move) return;
    drag.move(app.scene.toScene(event.clientX, event.clientY), event);
  });
  const end = (event) => {
    if (!drag) return;
    const finished = drag;
    drag = null;
    try { finished.target.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    finished.end?.(event.type === "pointercancel");
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

/** Is this scene point somewhere the user can currently see? */
export function inView(app, x, y) {
  const rect = app.host.getBoundingClientRect();
  const a = app.scene.toScene(rect.left, rect.top);
  const b = app.scene.toScene(rect.right, rect.bottom);
  return x >= a.x && x <= b.x && y >= a.y && y <= b.y;
}

/** The middle of what the user is looking at, in scene coordinates. */
export function viewCentre(app) {
  const rect = app.host.getBoundingClientRect();
  return app.scene.toScene(rect.left + rect.width / 2, rect.top + rect.height / 2);
}
