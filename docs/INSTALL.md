# Install

Two prerequisites, then three commands. Same on every platform, only the
prerequisite install differs.

| | Minimum | Why |
|---|---|---|
| **Node** | 20.19, or 22.12+ | Builds the frontend. Not needed to *run* the app, only to build it. |
| **Python** | 3.10 | Runs the window and the file/PDF/terminal services. |

Check what you have:

```bash
node -v && python3 --version
```

---

## macOS

Install the prerequisites if `node -v` fails:

```bash
brew install node
```

macOS ships a Python 3, but install your own if `python3 --version` reports
below 3.10:

```bash
brew install python
```

Then:

```bash
git clone https://github.com/Zehacksmith209/NTBK.git && cd NTBK
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
cd frontend && npm install && npm run build && cd ..
```

Run it:

```bash
./venv/bin/python ./ntbk/app.py
```

**Make it one word.** Add an alias so you never type that again:

```bash
echo "alias ntbk='cd $(pwd) && ./venv/bin/python ./ntbk/app.py'" >> ~/.zshrc && source ~/.zshrc
```

---

## Linux

```bash
sudo apt install python3 python3-venv nodejs npm    # Debian / Ubuntu
```

pywebview needs a webview backend. On GTK systems:

```bash
sudo apt install python3-gi gir1.2-webkit2-4.1
```

Then the same three commands as macOS, and run with:

```bash
./venv/bin/python ./ntbk/app.py
```

**Known gaps on Linux.** Toolchain discovery for code cells looks in macOS
locations, so MATLAB and some compilers may not be found automatically — set an
explicit command in the cell's Run box instead. Everything else works, including
the terminal.

---

## Windows

Install [Node](https://nodejs.org) and [Python](https://python.org) — during the
Python install, **tick "Add Python to PATH"**.

```powershell
git clone https://github.com/Zehacksmith209/NTBK.git
cd NTBK
python -m venv venv
.\venv\Scripts\pip install -r requirements.txt
cd frontend
npm install
npm run build
cd ..
```

Run it:

```powershell
.\venv\Scripts\python .\ntbk\app.py
```

**Known gap on Windows.** The interactive terminal in code cells does not work —
it needs a POSIX pty, which Windows does not have. Everything else runs: ink,
maths, plots, text, layers, the ruler, PDF export. See
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#the-terminal-in-a-code-cell-does-nothing-on-windows).

If you want the terminal and code cells, use WSL instead — see below.

---

## Windows with WSL

Follow this if you want **code cells and the terminal**, which the native
Windows build cannot provide. Everything else works either way, so if you are
not running code, the native install above is simpler.

WSL is a real Linux environment that runs alongside Windows. It does not
replace or disable anything — PowerShell, your files and your programs are
untouched. You open Ubuntu like any other app and run ntbk inside it.

**Git Bash is not a substitute.** It is a bash shell on top of Windows, so
Python launched from it is still Windows Python with no `pty` module. The
shell is not the part that matters; the kernel is.

### 1. Check WSL

In PowerShell:

```powershell
wsl --version
```

You need a **WSLg version** line — that is what lets a Linux window appear on
the Windows desktop. If the command is not recognised, install it from an
Administrator PowerShell and reboot:

```powershell
wsl --install
```

If `wsl -l -v` shows a distro at `VERSION 1`, upgrade it — WSL 1 has no WSLg:

```powershell
wsl --set-version Ubuntu 2
```

### 2. Install the dependencies

Everything from here runs **inside Ubuntu**, not PowerShell.

```bash
sudo apt install python3 python3-venv python3-gi gir1.2-webkit2-4.1
```

On Ubuntu 22.04 the WebKit package is `gir1.2-webkit2-4.0` instead. `lsb_release -a`
tells you which release you are on.

**Do not install Node from apt** — it ships 12 on 22.04 and 18 on 24.04, both
below the 20.19 this project needs, and `npm run build` will fail. Use nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22
```

### 3. Clone into the Linux home, not /mnt/c

This matters. Node on the Windows drive is very slow and Vite's file watching
does not fire reliably across the mount.

```bash
cd ~ && git clone https://github.com/Zehacksmith209/NTBK.git ntbk && cd ntbk
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
npm --prefix frontend install && npm --prefix frontend run build
```

### 4. Run it

```bash
cd ~/ntbk && export SHELL=/bin/bash && WEBKIT_DISABLE_DMABUF_RENDERER=1 ./venv/bin/python ./ntbk/app.py
```

Both of those are needed, and both are explained in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#wsl-the-window-opens-but-never-paints-not-responding):
`WEBKIT_DISABLE_DMABUF_RENDERER` stops WebKitGTK hanging under WSLg, and
`SHELL` works around a wrong default when the app is not started from a login
shell.

**Start the app from inside an Ubuntu terminal**, not from PowerShell via
`wsl …` and not from a shortcut. Launching from a real bash prompt means
`$SHELL` is always set, so that second workaround never has to matter.

---

## When you change the code

The app loads `frontend/dist`, not your source. After editing anything in
`frontend/src`, rebuild:

```bash
cd frontend && npm run build && cd ..
```

While actively developing, use the dev server instead — it hot-reloads, so no
rebuild is needed. Two terminals:

```bash
cd frontend && npm run dev
```

```bash
./venv/bin/python ./ntbk/app.py --dev
```

---

## Dependencies

**Python — two packages**, listed in `requirements.txt`:

- `pywebview` — the native window
- `pymupdf` — reads imported PDFs, writes exported ones

**JavaScript** — listed in `frontend/package.json` and bundled into `dist` at
build time. Nothing is fetched from a CDN, so the running app never touches the
network. The notable ones:

| | |
|---|---|
| `perfect-freehand` | pressure-sensitive ink outlines |
| `katex` | typeset maths |
| `jsxgraph` | 2D, 3D and statistics plots |
| `codemirror` | the code editor |
| `@tiptap/*` | rich text with inline maths |
| `@xterm/xterm` | the terminal |
| `polygon-clipping` | subtractive eraser masks |
| `html2canvas` | rasterises HTML boxes for PDF export |
