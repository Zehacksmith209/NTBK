import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Mathematics, migrateMathStrings, mathMigrationRegex }
  from "@tiptap/extension-mathematics";
import { registerObjectType } from "./registry.js";
import { createObject } from "../model/document.js";

// ─────────────────────────────────────────────
//  TEXT
//
//  Rich text on the canvas, through Tiptap.
//
//  Maths is the reason this exists rather than a
//  plain textarea: $E = mc^2$ typesets as you
//  type, through the same KaTeX the formula box
//  uses. Units, variables and expressions read
//  like LaTeX instead of like ASCII.
// ─────────────────────────────────────────────
export const DEFAULT_TEXT_SIZE = 16;

export function createTextObject(x, y) {
  return createObject({
    type: "text",
    x, y, w: 280, h: 60,
    payload: { html: "", fontSize: DEFAULT_TEXT_SIZE, color: "#111111" },
  });
}

registerObjectType("text", {
  mount(el, object, context) {
    el.classList.add("ntbk-text");

    const holder = document.createElement("div");
    holder.className = "ntbk-text-body ntbk-no-pan";
    el.appendChild(holder);

    let current = object;
    // What the editor is showing, kept as its own string: `update(next)` is
    // handed the live store object, so comparing it to a stored reference
    // compares it with itself.
    let shownHtml = object.payload.html ?? "";
    let echoing = false;
    let typesetting = false;
    let commitTimer = null;

    /**
     * Turn a finished $…$ into real maths.
     *
     * The extension's own input rule is anchored to the start of a block, so
     * it never fires for maths inside a sentence — which is where maths
     * actually lives. The regex needs a CLOSING $, so this can run on every
     * keystroke and only acts once the pair is complete.
     */
    function typesetMaths() {
      if (typesetting) return;
      let found = false;
      editorRef?.state.doc.descendants((node) => {
        if (node.isText && node.text && mathMigrationRegex.test(node.text)) found = true;
      });
      if (!found) return;
      typesetting = true;
      try {
        migrateMathStrings(editorRef);
      } finally {
        typesetting = false;
      }
    }

    let editorRef = null;

    const editor = new Editor({
      element: holder,
      content: object.payload.html || "",
      extensions: [
        StarterKit,
        TextStyle,
        Color,
        // $…$ inline, $$…$$ on its own line — the LaTeX habit, typeset live
        Mathematics.configure({
          katexOptions: { throwOnError: false, strict: false, trust: false },
        }),
      ],
      editorProps: {
        attributes: { class: "ntbk-text-editor", spellcheck: "false" },
      },
      onUpdate: () => {
        if (echoing || typesetting) return;
        typesetMaths();
        clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          shownHtml = editor.getHTML();
          context.updateObjectPayload(current.id,
            { ...current.payload, html: shownHtml }, "Edit text");
        }, 500);
      },
    });

    editorRef = editor;
    // Content arriving from a saved file gets the same treatment
    typesetMaths();

    applyStyle(el, object.payload);

    /**
     * A text box has two modes, and the difference is who gets the pointer.
     *
     * While you are typing, the box keeps its clicks so you can place the
     * caret and drag a text selection. The rest of the time it must let them
     * through, or the canvas never sees the click and the box can't be
     * selected, moved, resized or deleted like any other object.
     */
    let watchingOutside = null;

    function setEditing(on) {
      editor.setEditable(on);
      el.classList.toggle("is-editing", on);

      // Leaving on blur alone is not enough: focus can sit somewhere odd and
      // the box would stay in editing mode, swallowing the very clicks meant
      // to select it. Watching for a pointer landing outside is what makes
      // getting out of edit mode reliable.
      if (on && !watchingOutside) {
        watchingOutside = (event) => {
          if (!el.contains(event.target)) setEditing(false);
        };
        // Capture, so it is seen before anything can stop it
        document.addEventListener("pointerdown", watchingOutside, true);
      } else if (!on && watchingOutside) {
        document.removeEventListener("pointerdown", watchingOutside, true);
        watchingOutside = null;
      }

      if (on) editor.commands.focus("end");
    }
    setEditing(false);

    for (const type of ["pointerdown", "pointermove", "pointerup", "dblclick"]) {
      holder.addEventListener(type, (event) => {
        if (editor.isEditable) event.stopPropagation();
      });
    }
    // Keystrokes never reach the canvas, or every letter would be a shortcut
    holder.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
    });
    // Clicking away puts it back to being an ordinary object
    editor.on("blur", () => setEditing(false));

    // The selection chrome covers the box once it is selected, so the canvas
    // routes the double-click through by hand — same path the formula uses
    el.addEventListener("ntbk:edit", () => setEditing(true));

    return {
      update(next) {
        current = next;
        applyStyle(el, next.payload);
        const html = next.payload.html ?? "";
        if (html !== shownHtml && !editor.isFocused) {
          // Changed from outside — an undo, or the inspector. Never while you
          // are typing in here, which would fight the caret.
          echoing = true;
          try {
            editor.commands.setContent(html, { emitUpdate: false });
          } finally {
            echoing = false;
          }
          shownHtml = html;
          typesetMaths();
        }
      },
      /** Bold the selection, or the next thing typed. */
      toggleBold() {
        setEditing(true);
        editor.chain().focus().toggleBold().run();
      },
      isBold() {
        return editor.isActive("bold");
      },
      focus() {
        setEditing(true);
      },
      destroy() {
        clearTimeout(commitTimer);
        if (watchingOutside) {
          document.removeEventListener("pointerdown", watchingOutside, true);
          watchingOutside = null;
        }
        editor.destroy();
      },
    };
  },
});

function applyStyle(el, payload) {
  el.style.setProperty("--text-size", `${payload.fontSize ?? DEFAULT_TEXT_SIZE}px`);
  el.style.setProperty("--text-color", payload.color ?? "#111111");
}
