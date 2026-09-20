# Troubleshooting

Every error below is one that actually happened, with the fix that actually
worked.

**First: where errors go.** The app prints failures to whatever terminal you
started it from. If something fails silently, look there — most "it just didn't
work" turns out to be a traceback nobody read.

---

## `ModuleNotFoundError: No module named 'webview'`

You ran the wrong Python. `python3` is not the one with the dependencies.

```bash
./venv/bin/python ./ntbk/app.py
```

The `./venv/bin/` part is the whole point. On Windows it is
`.\venv\Scripts\python`.

If it persists, the venv was never populated:

```bash
./venv/bin/pip install -r requirements.txt
```

---

## `frontend/dist not found`

The frontend has not been built. The app loads the built bundle, not your source.

```bash
cd frontend && npm run build && cd ..
```

---

## `cd: not a directory: venv/bin/python`

`cd` moves between folders; `python` is a program, not a folder. You do not
need to `cd` anywhere — from the project root, run:

```bash
./venv/bin/python ./ntbk/app.py
```

---

## Double-clicking a `.ntbk` says "There is no application set to open it"

Expected. macOS learns file associations from installed `.app` bundles, and ntbk
is currently a Python script, so there is nothing for macOS to associate.

Your file is fine. Open it from inside the app: **File → Open**.

You can also pass it on the command line:

```bash
./venv/bin/python ./ntbk/app.py ~/Documents/notes.ntbk
```

Double-click support needs a packaged `.app` — not built yet.

---

## The app opened, but it looks like an old version

You ran `ntbk_app_old_python_prototype.py`, the PyQt6 prototype, instead of
`ntbk/app.py`. Note the slash:

```bash
./venv/bin/python ./ntbk/app.py
```

The current app has a ribbon reading **File · Home · Tools · Insert**.

---

## A code cell says "No default command for x.py"

ntbk runs code with the compilers and interpreters **already on your machine**.
That message means the one for this file type is not installed, or is not on
your `PATH`.

Either install it, or type an explicit command in the cell's **Run** box, e.g.
`python3 x.py`.

To check what ntbk can see, open a code cell's terminal and run `which python3`,
`which g++`, and so on.

---

## The terminal in a code cell does nothing on Windows

Known limitation. The terminal uses a POSIX pty (`pty`, `termios`, `fcntl`),
which does not exist on Windows. Everything else works — ink, maths, plots,
text, layers, the ruler, PDF export.

Supporting it needs a ConPTY backend (`pywinpty`). Not built yet.

---

## Ctrl+C does not stop a running program

It should. If it does not, press the cell's **Stop** button twice — the second
press kills the process group outright rather than asking it politely.

---

## Custom shapes disappeared after restarting

Fixed. Shapes used to be written to a macOS temp folder, which the system wipes.

They now live in:

- `~/Documents/ntbk/shapes/` — your personal library, always available
- `<folder containing your .ntbk>/shapes/` — once the notebook has been saved

The Shapes menu lists both. Each shape is one `.ntbkshape` file, so you can drag
them between folders in Finder to carry them to another topic.

Shapes saved before this fix are gone and need re-making.

---

## Imported pictures look blurry

Fixed, but worth understanding. Two causes, both addressed:

1. Images were capped at one image pixel per **CSS** pixel, which on a Retina
   display still stretched them 2×. The cap now counts **device** pixels.
2. Panning left the page on fractional device pixels, so everything — ink
   included — was resampled. The page now lands on whole device pixels.

What cannot be fixed: **zooming in**. At 2× zoom you are asking for twice the
detail the file contains. Use a higher-resolution original.

---

## The PDF saved but I cannot find it

Fixed. If it recurs:

- The save dialog opens in your notebook's folder, or `~/Documents` if unsaved
- Finder opens with the file selected the moment it is written
- The status bar names the path

If it fails, the error appears in the status bar **and** in the terminal.

---

## A stroke I drew is not in the object panel

Correct behaviour. Freehand ink is deliberately not listed — a page of
handwriting would bury the panel in hundreds of rows.

Listed items are: objects (formulas, plots, text, code cells, images, PDF
pages), drawn shapes (rectangle, ellipse, line, arrow, triangle), and custom
shapes you have saved and placed.

To get handwriting into the panel, select it and use **Shapes → Save selection
as a shape**, then place it. It then counts as one object.

---

## Ink goes under the ruler, or does not snap

Both fixed. Ink snaps to **either** long edge within about 26 px, and the ruler
physically blocks the pen underneath it — a stroke crossing the ruler breaks and
resumes on the other side.

If nothing snaps, check the ruler is actually out: the status bar says **"Ruler
out — ink snaps to its edge"** versus **"Ruler away"**.

---

## Everything is fine but the window is blank

The frontend built into a state the app cannot load. Rebuild:

```bash
cd frontend && npm run build && cd ..
```

If it is still blank, run with the inspector and check the console:

```bash
./venv/bin/python ./ntbk/app.py --debug
```

---

## npm install fails

Check your Node version:

```bash
node -v
```

Below 20.19 will not work. Install a current Node from
[nodejs.org](https://nodejs.org) and try again.
