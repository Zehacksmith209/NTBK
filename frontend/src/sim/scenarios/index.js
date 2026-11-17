import massSpringDamper from "./massSpringDamper.js";

// ─────────────────────────────────────────────
//  THE SCENARIO LIBRARY
//
//  Every simulation a notebook can hold. A new
//  one is a file in this folder and a line here;
//  nothing else in the app needs to change.
// ─────────────────────────────────────────────
export const SCENARIOS = [massSpringDamper];

export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id) ?? null;

/** Grouped for the Insert menu, in the order the categories first appear. */
export function scenariosByCategory() {
  const groups = new Map();
  for (const s of SCENARIOS) {
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push(s);
  }
  return groups;
}
