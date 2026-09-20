// ─────────────────────────────────────────────
//  UNDO / REDO
//
//  A command carries the data needed to run
//  itself in both directions, captured at the
//  moment it was created. Built in from the
//  start because retrofitting undo is misery.
//
//  Not persisted to .ntbk — it lives only for
//  the session.
// ─────────────────────────────────────────────
export class History {
  constructor(store, { limit = 200 } = {}) {
    this.store = store;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) fn(this);
  }

  /** Run a command and make it undoable. */
  run(command) {
    command.redo(this.store);
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0; // a new action invalidates the redo branch
    this._notify();
  }

  /**
   * Record a command that has ALREADY been applied.
   * Live gestures (dragging, erasing) mutate the store as they go for
   * feedback; replaying them on commit would double-apply.
   */
  record(command) {
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._notify();
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo(this.store);
    this.redoStack.push(command);
    this._notify();
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return;
    command.redo(this.store);
    this.undoStack.push(command);
    this._notify();
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._notify();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? null; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? null; }
}

// ─────────────────────────────────────────────
//  COMMANDS
//  Each snapshots what it needs up front, so
//  undo never has to reconstruct anything.
// ─────────────────────────────────────────────
const clone = (value) => JSON.parse(JSON.stringify(value));

export function addElements(elements, label = "Add") {
  const snapshot = clone(elements);
  const ids = snapshot.map((e) => e.id);
  return {
    label,
    redo: (store) => store.insertMany(clone(snapshot)),
    undo: (store) => store.removeMany(ids),
  };
}

export function removeElements(store, ids, label = "Delete") {
  const snapshot = clone(ids.map((id) => store.find(id)).filter(Boolean));
  const realIds = snapshot.map((e) => e.id);
  return {
    label,
    redo: (s) => s.removeMany(realIds),
    undo: (s) => s.insertMany(clone(snapshot)),
  };
}

/**
 * entries: [{ id, before: {...}, after: {...} }]
 * Used for moves, resizes and restyling — anything that changes fields
 * on existing elements rather than adding or removing them.
 */
export function patchElements(entries, label = "Change") {
  const snapshot = clone(entries);
  return {
    label,
    redo: (store) => store.patchMany(
      snapshot.map((e) => ({ id: e.id, changes: clone(e.after) }))),
    undo: (store) => store.patchMany(
      snapshot.map((e) => ({ id: e.id, changes: clone(e.before) }))),
  };
}

/** Adding or removing pages, as one undoable step. */
export function setPages(before, after, label = "Pages") {
  const from = clone(before);
  const to = clone(after);
  return {
    label,
    redo: (store) => store.setPages(clone(to)),
    undo: (store) => store.setPages(clone(from)),
  };
}

/** Adding, renaming, hiding or locking layers, as one undoable step. */
export function setLayersCommand(before, after, label = "Layers") {
  const from = clone(before);
  const to = clone(after);
  return {
    label,
    redo: (store) => store.setLayers(clone(to)),
    undo: (store) => store.setLayers(clone(from)),
  };
}
