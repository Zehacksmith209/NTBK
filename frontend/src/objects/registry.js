// ─────────────────────────────────────────────
//  OBJECT TYPE REGISTRY
//
//  The extension point. A new box type is a new
//  entry here plus a `type` string in the JSON —
//  never a format migration. That's what keeps
//  CAD sketches or 3D embeds additive later.
//
//  mount(el, object, context) -> { update?, destroy? }
// ─────────────────────────────────────────────
export const registry = new Map();

export function registerObjectType(type, definition) {
  registry.set(type, definition);
}
