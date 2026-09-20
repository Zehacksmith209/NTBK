// ─────────────────────────────────────────────
//  NUMBER FIELD
//
//  Makes a slider's readout typeable.
//
//  Drag for feel, type for precision. A slider
//  alone cannot reliably hit 12.5, and the
//  number sitting next to it is the obvious
//  place to say so — so it stops being a label
//  and becomes an input.
// ─────────────────────────────────────────────

/**
 * Replace a slider's <output> with a box you can type into.
 *
 * The typed value is written back to the range and then the range's OWN
 * `input` and `change` events are fired. That is what lets this be dropped
 * on top of existing sliders without touching their handlers: whatever
 * already listened for a drag now hears a typed value identically.
 *
 * @param range      the <input type="range">
 * @param readout    the <output> to replace
 * @param toDisplay  raw slider value -> the number shown (e.g. radians to degrees)
 * @param fromDisplay the shown number -> raw slider value
 * @param unit       appended for display only, and stripped when parsing
 * @param decimals   how many to show; trailing zeros are trimmed
 */
export function typeableReadout(range, readout, {
  toDisplay = (v) => v,
  fromDisplay = (v) => v,
  unit = "",
  decimals = 2,
} = {}) {
  if (!range || !readout) return null;

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.className = "ntbk-readout";
  input.title = "Type a value, or drag the slider";
  readout.replaceWith(input);

  const show = () => {
    const shown = toDisplay(Number(range.value));
    // Trim trailing zeros: 2.50 reads worse than 2.5, and 3.00 worse than 3
    input.value = `${Number(shown.toFixed(decimals))}${unit}`;
  };

  const commit = () => {
    const typed = Number.parseFloat(String(input.value).replace(unit, "").trim());
    if (!Number.isFinite(typed)) return show();   // rubbish just reverts

    // Clamp to what the slider allows, so typing 900 cannot produce a state
    // the slider could never reach and the UI could never show
    const min = toDisplay(Number(range.min));
    const max = toDisplay(Number(range.max));
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    const clamped = Math.min(high, Math.max(low, typed));

    range.value = String(fromDisplay(clamped));
    show();
    // Speak the slider's language, so existing handlers need no changes
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  };

  input.addEventListener("keydown", (event) => {
    event.stopPropagation();            // digits must never reach the canvas
    if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    if (event.key === "Escape") { show(); input.blur(); }
    // Arrow keys nudge by the slider's own step, like the slider does
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const step = Number(range.step) || 1;
      const direction = event.key === "ArrowUp" ? 1 : -1;
      range.value = String(Number(range.value) + step * direction * (event.shiftKey ? 10 : 1));
      show();
      range.dispatchEvent(new Event("input", { bubbles: true }));
      range.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("focus", () => input.select());
  range.addEventListener("input", show);

  show();
  return { input, show };
}
