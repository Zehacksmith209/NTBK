// ─────────────────────────────────────────────
//  TEXT TOOL
//
//  Click once, get a caret. The box lands on the
//  page's grid rather than exactly where you
//  clicked, so two paragraphs can actually be
//  lined up — the way a text editor behaves.
//  Drag it anywhere afterwards.
// ─────────────────────────────────────────────
export class TextTool {
  constructor(app) {
    this.app = app;
    this.cursor = "text";
  }

  onPointerDown(event, point) {
    if (event.button !== 0) return;
    this.app.insertText(point);
  }

  onPointerMove() {}
  onPointerUp() {}
  onCancel() {}
}
