import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { registerObjectType } from "./registry.js";
import { createObject } from "../model/document.js";
import { bridge } from "../bridge.js";

// ─────────────────────────────────────────────
//  CODE CELL
//
//  An editor and a real terminal, the way an IDE
//  does it. The terminal is the user's own shell
//  running in the notebook's working directory,
//  so input() shows its prompt and waits, Ctrl+C
//  interrupts, and you can type shell commands
//  directly. Run just types the command for you.
//
//  The filename does three jobs: names the
//  window, picks the language, and names the
//  real file written beside the notebook.
//
//  Nothing runs on open — only when you ask.
// ─────────────────────────────────────────────
const LANGUAGE_MODES = {
  ".py": python, ".js": javascript,
  ".c": cpp, ".cpp": cpp, ".cc": cpp, ".h": cpp,
  ".java": java,
};

const STARTERS = {
  ".py": 'name = input("Your name? ")\nprint("hello,", name)\n',
  ".js": 'console.log("hello");\n',
  ".c": '#include <stdio.h>\n\nint main(void) {\n    printf("hello\\n");\n    return 0;\n}\n',
  ".cpp": '#include <iostream>\n\nint main() {\n    std::cout << "hello\\n";\n}\n',
  ".java": 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("hello");\n    }\n}\n',
};

export const extensionOf = (filename) =>
  (String(filename).match(/\.[^.]+$/) ?? [""])[0].toLowerCase();

const stemOf = (filename) => String(filename).replace(/\.[^.]+$/, "");

/**
 * What Run types into the shell.
 *
 * The cell's own command wins if it has one, otherwise the template comes
 * from Python's language table — one source of truth, so adding a language
 * there is the only change needed.
 */
export function runCommandFor(filename, languages = {}, override = "") {
  if (override && override.trim()) return override.trim();
  const template = languages[extensionOf(filename)]?.command;
  if (!template) return null;
  return template
    .replaceAll("{file}", JSON.stringify(filename))
    .replaceAll("{stem}", stemOf(filename));
}

export function starterFor(filename) {
  return STARTERS[extensionOf(filename)] ?? "";
}

export function createCodeObject(x, y, filename) {
  return createObject({
    type: "code",
    // Above the ink: a code cell is a working window, not something you
    // write on top of
    layer: "overlay",
    x, y, w: 600, h: 420,
    // runCommand empty means "use the table"; typing one here makes the cell
    // run anything, including languages the table has never heard of
    payload: { filename, source: starterFor(filename), transcript: "", runCommand: "" },
  });
}

const MAX_TRANSCRIPT = 40000;   // trimmed, so notebooks don't bloat

registerObjectType("code", {
  mount(el, object, context) {
    el.classList.add("ntbk-code");
    el.innerHTML = `
      <div class="ntbk-code-head">
        <input class="ntbk-code-name" spellcheck="false" title="Filename decides the language">
        <span class="ntbk-code-lang"></span>
        <button class="ntbk-code-run" title="Run this file">▶ Run</button>
        <button class="ntbk-code-stop" title="Interrupt (Ctrl+C). Press again to force quit." hidden>■ Stop</button>
      </div>
      <div class="ntbk-code-cmd">
        <label>Run</label>
        <input class="ntbk-code-command" spellcheck="false"
               title="Leave empty to use the default for this file type">
      </div>
      <div class="ntbk-code-tabs"></div>
      <div class="ntbk-code-body">
        <div class="ntbk-code-pane" data-pane="code"></div>
        <div class="ntbk-code-pane" data-pane="term" hidden></div>
      </div>`;

    const nameInput = el.querySelector(".ntbk-code-name");
    const langLabel = el.querySelector(".ntbk-code-lang");
    const runButton = el.querySelector(".ntbk-code-run");
    const commandInput = el.querySelector(".ntbk-code-command");
    const stopButton = el.querySelector(".ntbk-code-stop");
    const tabStrip = el.querySelector(".ntbk-code-tabs");
    const body = el.querySelector(".ntbk-code-body");
    const codePane = el.querySelector('[data-pane="code"]');
    const termPane = el.querySelector('[data-pane="term"]');

    el.querySelector(".ntbk-code-head").classList.add("is-drag-handle");

    let current = object;
    let editor = null;
    let term = null;
    let fit = null;
    let reading = false;
    let transcript = object.payload.transcript ?? "";
    let artefactUrls = [];
    let activePane = "code";

    // Only the working area swallows events. Blocking the whole cell meant
    // the canvas never saw a click on it, so it could not be selected,
    // dragged, resized or deleted like any other object.
    //
    // The title bar and tab strip deliberately let events through: pressing
    // them selects the window and starts a drag, the way a window behaves.
    const swallow = (node) => {
      for (const type of ["pointerdown", "pointermove", "pointerup", "wheel",
                          "dblclick", "keydown"]) {
        node.addEventListener(type, (event) => event.stopPropagation());
      }
    };
    swallow(body);
    swallow(nameInput);
    swallow(commandInput);
    swallow(runButton);
    swallow(stopButton);

    // ── Tabs ──
    function showPane(name) {
      activePane = name;
      for (const pane of el.querySelectorAll(".ntbk-code-pane")) {
        pane.hidden = pane.dataset.pane !== name;
      }
      for (const tab of tabStrip.querySelectorAll(".ntbk-code-tab")) {
        tab.classList.toggle("is-active", tab.dataset.tab === name);
      }
      if (name === "code") editor?.focus();
      if (name === "term") { fitTerminal(); term?.focus(); }
    }

    function addTab(key, label) {
      const tab = document.createElement("button");
      tab.className = "ntbk-code-tab";
      tab.dataset.tab = key;
      tab.textContent = label;
      tab.addEventListener("click", () => showPane(key));
      tabStrip.appendChild(tab);
    }

    function buildTabs(artefacts = []) {
      tabStrip.innerHTML = "";
      addTab("code", "Code");
      addTab("term", "Terminal");

      for (const url of artefactUrls) URL.revokeObjectURL(url);
      artefactUrls = [];
      for (const pane of el.querySelectorAll('[data-pane^="art"]')) pane.remove();

      artefacts.forEach((item, index) => {
        const key = `art${index}`;
        addTab(key, item.name);

        const pane = document.createElement("div");
        pane.className = "ntbk-code-pane";
        pane.dataset.pane = key;
        pane.hidden = true;

        const bytes = Uint8Array.from(atob(item.data), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: item.mime }));
        artefactUrls.push(url);

        if (item.mime.startsWith("image/")) {
          const img = document.createElement("img");
          img.src = url;
          img.className = "ntbk-code-artefact";
          pane.appendChild(img);
        } else {
          const frame = document.createElement("iframe");
          frame.src = url;
          frame.className = "ntbk-code-artefact";
          frame.sandbox = "";   // rendered output shouldn't reach the app
          pane.appendChild(frame);
        }
        body.appendChild(pane);
      });
    }

    // ── Editor ──
    function buildEditor(filename, source) {
      editor?.destroy();
      codePane.innerHTML = "";
      const mode = LANGUAGE_MODES[extensionOf(filename)];
      editor = new EditorView({
        state: EditorState.create({
          doc: source,
          extensions: [
            basicSetup,
            ...(mode ? [mode()] : []),
            EditorView.updateListener.of((u) => { if (u.docChanged) scheduleCommit(); }),
          ],
        }),
        parent: codePane,
      });
    }

    let commitTimer = null;
    function scheduleCommit() {
      clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        context.updateObjectPayload(current.id, {
          ...current.payload,
          source: editor.state.doc.toString(),
          transcript: transcript.slice(-MAX_TRANSCRIPT),
        });
      }, 700);
    }

    // ── Terminal ──
    function fitTerminal() {
      if (!term || termPane.hidden) return;
      try {
        fit.fit();
        bridge.termResize(current.id, term.cols, term.rows);
      } catch { /* pane not laid out yet */ }
    }

    async function openTerminal() {
      if (term) return;
      term = new Terminal({
        fontSize: 12,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        theme: { background: "#ffffff", foreground: "#1c1f24", cursor: "#1a6ef5",
                 selectionBackground: "#cfe0fd" },
        cursorBlink: true,
        convertEol: true,
        scrollback: 4000,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termPane);

      // What the last session printed, so reopening a notebook shows its
      // results without anything being re-run
      if (transcript) term.write(transcript);

      term.onData((data) => {
        bridge.termWrite(current.id, data);
        // Interrupting aborts the whole command list in zsh, so the
        // end-marker never runs and the button would sit on "Running…"
        // forever. Treat Ctrl+C as the end of the run.
        if (data.includes("\x03")) finishRun();
      });

      await bridge.termOpen(current.id, term.cols || 80, term.rows || 24);
      fitTerminal();
      pump();
    }

    /** Long-poll the pty. One read at a time; each waits briefly for output. */
    async function pump() {
      if (reading) return;
      reading = true;
      while (reading) {
        let result;
        try {
          result = await bridge.termRead(current.id);
        } catch {
          break;
        }
        if (!reading) break;

        if (result?.data) {
          const text = atob(result.data);
          const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
          const decoded = new TextDecoder().decode(bytes);
          term.write(decoded);
          transcript = (transcript + decoded).slice(-MAX_TRANSCRIPT);
          scheduleCommit();
        }

        if (result?.done) {
          finishRun();
          if (result.done.artefacts?.length) {
            buildTabs(result.done.artefacts);
            showPane("art0");
          }
        }
        if (result && result.alive === false) break;
      }
      reading = false;
    }

    // ── Running ──
    async function run() {
      const filename = nameInput.value.trim() || current.payload.filename;
      // The table may not have arrived yet on a freshly opened window
      if (!Object.keys(context.languages?.() ?? {}).length) {
        await context.reloadLanguages?.();
        apply(current);
      }
      const command = runCommandFor(filename, context.languages?.() ?? {},
                                    commandInput.value);
      if (!command) {
        await openTerminal();
        showPane("term");
        term?.write(
          `\r\n\x1b[31mNo default command for ${filename}.\x1b[0m ` +
          `Type one in the Run box above, or run it yourself below.\r\n`);
        return;
      }

      await openTerminal();
      showPane("term");
      runButton.disabled = true;
      runButton.textContent = "Running…";
      stopButton.hidden = false;
      stopPresses = 0;

      // The shell runs the file from disk, so write it first
      await bridge.saveSource(filename, editor.state.doc.toString());
      await bridge.termRun(current.id, command);
      if (commandInput.value.trim() !== (current.payload.runCommand ?? "")) {
        context.updateObjectPayload(current.id,
          { ...current.payload, runCommand: commandInput.value.trim() });
      }
    }

    function finishRun() {
      runButton.disabled = false;
      runButton.textContent = "▶ Run";
      stopButton.hidden = true;
      stopPresses = 0;
    }

    // First press interrupts; a second press within a few seconds means the
    // program is ignoring SIGINT, so kill the group outright
    let stopPresses = 0;
    let stopTimer = null;
    stopButton.addEventListener("click", async () => {
      stopPresses += 1;
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => { stopPresses = 0; }, 4000);
      await bridge.termInterrupt(current.id, stopPresses > 1);
      // Give the program a beat to die before saying the run is over
      setTimeout(finishRun, 400);
      term?.focus();
    });

    runButton.addEventListener("click", run);

    commandInput.addEventListener("change", () => {
      context.updateObjectPayload(current.id,
        { ...current.payload, runCommand: commandInput.value.trim() });
    });

    nameInput.addEventListener("change", () => {
      const filename = nameInput.value.trim();
      if (!filename || filename === current.payload.filename) return;
      context.updateObjectPayload(current.id, { ...current.payload, filename });
    });

    // Cmd/Ctrl+Enter runs, like every notebook. Bound on the body because
    // that is where the keystroke actually happens.
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        run();
      }
    }, true);

    function apply(next) {
      current = next;
      nameInput.value = next.payload.filename;
      langLabel.textContent = context.languageName?.(next.payload.filename) ?? "";
      if (document.activeElement !== commandInput) {
        // Show the default greyed out, so it is obvious what will run and
        // equally obvious that you can change it
        const preset = runCommandFor(next.payload.filename,
                                     context.languages?.() ?? {}, "");
        commandInput.value = next.payload.runCommand ?? "";
        commandInput.placeholder = preset ?? "type a command to run this file";
      }
    }

    buildTabs([]);
    buildEditor(object.payload.filename, object.payload.source ?? "");
    apply(object);
    showPane("code");

    const resizeWatcher = new ResizeObserver(() => fitTerminal());
    resizeWatcher.observe(termPane);

    return {
      update(next) {
        const filenameChanged = next.payload.filename !== current.payload.filename;
        const wasFilename = current.payload.filename;
        current = next;
        if (filenameChanged && next.payload.filename !== wasFilename) {
          buildEditor(next.payload.filename, editor.state.doc.toString());
        }
        apply(next);
      },
      destroy() {
        reading = false;
        clearTimeout(commitTimer);
        resizeWatcher.disconnect();
        editor?.destroy();
        term?.dispose();
        bridge.termClose(object.id);
        for (const url of artefactUrls) URL.revokeObjectURL(url);
      },
    };
  },
});
