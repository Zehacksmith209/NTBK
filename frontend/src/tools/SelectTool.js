import { strokeHit, strokeInsideRect } from "../canvas/spatial.js";

// ─────────────────────────────────────────────
//  SELECT
//
//  Click picks one element. Dragging on empty
//  canvas marquees, and a stroke has to sit
//  *entirely* inside the marquee to be caught —
//  the same rule the Qt prototype used, and the
//  one that makes it possible to select a word
//  without dragging in the line beside it.
// ─────────────────────────────────────────────
export class SelectTool {
  constructor(app) {
    this.app = app;
    this.cursor = "default";
    this.marqueeStart = null;
  }

  onPointerDown(event, point) {
    if (event.button !== 0) return;
    const controller = this.app.selectionController;

    // Pressing anywhere inside the selection drags the whole thing, gaps
    // between strokes included — same rule as the Qt prototype
    if (!event.shiftKey && controller.contains(point)) {
      controller.beginMove(point);
      return;
    }

    const hit = this.app.hitTest(point);
    if (hit) {
      const additive = event.shiftKey;
      const already = this.app.selection.has(hit);
      if (additive) {
        this.app.setSelection(
          already
            ? [...this.app.selection].filter((id) => id !== hit)
            : [...this.app.selection, hit],
        );
        return;
      }
      if (!already) this.app.setSelection([hit]);
      // Select and drag in one gesture, so grabbing a box just works
      controller.beginMove(point);
      return;
    }

    if (!event.shiftKey) this.app.setSelection([]);
    this.marqueeStart = point;
  }

  onPointerMove(event, point) {
    const controller = this.app.selectionController;
    if (controller.moving) {
      controller.moveTo(point);
      return;
    }
    if (!this.marqueeStart) {
      // Tell the user the selection is grabbable before they try
      this.app.host.style.cursor = controller.contains(point) ? "move" : "default";
      return;
    }
    this.app.scene.drawMarquee(rectOf(this.marqueeStart, point));
  }

  onPointerUp(event, point) {
    const controller = this.app.selectionController;
    if (controller.moving) {
      controller.endMove();
      return;
    }
    if (!this.marqueeStart) return;
    const rect = rectOf(this.marqueeStart, point);
    this.marqueeStart = null;
    this.app.scene.clearChrome();

    if (rect.maxX - rect.minX < 3 && rect.maxY - rect.minY < 3) return;

    const picked = [];
    for (const id of this.app.scene.index.search(rect.minX, rect.minY, rect.maxX, rect.maxY)) {
      const stroke = this.app.store.find(id);
      if (stroke && strokeInsideRect(stroke, rect)) picked.push(id);
    }
    for (const object of this.app.store.objects) {
      if (object.x >= rect.minX && object.y >= rect.minY
          && object.x + object.w <= rect.maxX
          && object.y + object.h <= rect.maxY) {
        picked.push(object.id);
      }
    }

    this.app.setSelection(event.shiftKey ? [...new Set([...this.app.selection, ...picked])] : picked);
  }

  onCancel() {
    this.marqueeStart = null;
    this.app.selectionController?.endMove();
    this.app.scene.clearChrome();
  }
}

function rectOf(a, b) {
  return {
    minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
  };
}

/** Topmost element under a scene point, objects first, then ink. */
export function hitTestAt(app, point) {
  const objects = app.store.objects;
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (point.x >= o.x && point.x <= o.x + o.w
        && point.y >= o.y && point.y <= o.y + o.h) {
      return o.id;
    }
  }

  const tolerance = 6 / app.scene.scale; // constant grab area on screen
  const candidates = app.scene.index.near(point.x, point.y, tolerance + 20);
  let best = null;
  for (const id of candidates) {
    const stroke = app.store.find(id);
    if (stroke && strokeHit(stroke, point.x, point.y, tolerance)) best = id;
  }
  return best;
}
