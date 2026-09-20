import { registry } from "../objects/registry.js";

// ─────────────────────────────────────────────
//  OBJECT LAYER
//
//  Every box type is a real DOM element, so CSS
//  styles it and libraries drop straight in.
//
//  Two layers, not one: "content" sits under the
//  ink so you can write over a formula the way
//  you'd write over anything else on the page,
//  and "overlay" sits above it for things that
//  behave like floating windows.
// ─────────────────────────────────────────────
export class ObjectLayer {
  constructor(contentEl, overlayEl, context) {
    this.contentEl = contentEl;
    this.overlayEl = overlayEl;
    this.context = context;
    this.nodes = new Map(); // id -> { el, handle }
  }

  _host(object) {
    // "over" is for things you work IN, like a code cell; everything else
    // sits under the ink so you can write on it
    return object.band === "over" ? this.overlayEl : this.contentEl;
  }

  render(object) {
    const type = registry.get(object.type);
    if (!type) {
      console.warn(`No renderer registered for object type "${object.type}"`);
      return null;
    }

    let node = this.nodes.get(object.id);
    if (!node) {
      const el = document.createElement("div");
      el.className = "ntbk-object";
      el.dataset.id = object.id;
      el.dataset.type = object.type;
      this._host(object).appendChild(el);
      const handle = type.mount(el, object, this.context);
      node = { el, handle };
      this.nodes.set(object.id, node);
    } else {
      node.handle?.update?.(object);
    }

    this._position(node.el, object);
    return node.el;
  }

  _position(el, object) {
    el.style.left = `${object.x}px`;
    el.style.top = `${object.y}px`;
    el.style.width = object.w ? `${object.w}px` : "auto";
    el.style.height = object.h ? `${object.h}px` : "auto";
    const parts = [];
    if (object.rotation) parts.push(`rotate(${object.rotation}deg)`);
    if (object.flipX || object.flipY) {
      parts.push(`scale(${object.flipX ? -1 : 1}, ${object.flipY ? -1 : 1})`);
    }
    el.style.transform = parts.join(" ");
  }

  remove(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.handle?.destroy?.();
    node.el.remove();
    this.nodes.delete(id);
  }

  clear() {
    for (const id of [...this.nodes.keys()]) this.remove(id);
  }

  elementFor(id) {
    return this.nodes.get(id)?.el ?? null;
  }

  setHighlighted(ids) {
    const set = new Set(ids);
    for (const [id, node] of this.nodes) {
      node.el.classList.toggle("is-selected", set.has(id));
    }
  }
}
