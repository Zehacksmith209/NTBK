import base64
import io
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
import tempfile
import zipfile

import webview

# services/ lives beside this file
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ─────────────────────────────────────────────
#  PYTHON API EXPOSED TO JS
#
#  Services only — filesystem now, code
#  execution and PDF export later. Python draws
#  nothing; the frontend owns all rendering.
#
#  A .ntbk is a zip: document.json plus an
#  assets/ folder holding the media verbatim.
# ─────────────────────────────────────────────
class Api:
    def __init__(self):
        self.current_path = None
        # Each window owns its own Api, so its own document, terminals and
        # working directory. These are filled in by the shell once the window
        # exists — see attach().
        self.window = None
        self._spawn = None
        self.pending_open = None   # a .ntbk named on the command line
        self._pdfs = {}          # asset id -> open PDF, so bytes cross once
        self._scratch = None     # working dir used until the notebook is saved
        self._terminals = None   # one pty per code cell, created on demand

    # ── Documents ──────────────────────────────
    def attach(self, window, spawn):
        """Told which window this Api belongs to, and how to make another."""
        self.window = window
        self._spawn = spawn
        return self

    def _window(self):
        # Falls back to the first window only if attach() was never called,
        # which would mean a dialog on the wrong window rather than a crash
        return self.window or webview.windows[0]

    def new_window(self):
        """Open a second notebook in its own window, with its own document."""
        if not self._spawn:
            return json.dumps({"ok": False, "error": "This build cannot open windows"})
        self._spawn()
        return json.dumps({"ok": True})

    def set_title(self, title):
        """Name the window after its document, so a row of them is readable."""
        try:
            self._window().set_title(f"{title} — ntbk" if title else "ntbk")
            return True
        except Exception:
            return False

    def save_ntbk(self, document_json, assets=None, suggested_name="untitled.ntbk",
                  sources=None):
        window = self._window()

        path = self.current_path
        if path is None:
            result = window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggested_name,
                file_types=("ntbk notebook (*.ntbk)",),
            )
            if not result:
                return None
            path = result if isinstance(result, str) else result[0]

        if not path.endswith(".ntbk"):
            path += ".ntbk"

        # Build in memory first, so a failure part-way through can't leave a
        # half-written file where the user's notes used to be
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("document.json", document_json)
            for asset_path, encoded in (assets or {}).items():
                # Media is already compressed — storing it uncompressed is
                # faster and very nearly the same size
                archive.writestr(asset_path, base64.b64decode(encoded),
                                 compress_type=zipfile.ZIP_STORED)

        with open(path, "wb") as handle:
            handle.write(buffer.getvalue())

        self.current_path = path
        # Code cells are mirrored to a folder beside the notebook, so the .py
        # and .cpp files are real files you can open, run and compile outside
        # the app. The notebook stays the source of truth; this is a copy.
        self._mirror_sources(sources)
        return os.path.basename(path)

    def save_ntbk_as(self, document_json, assets=None, suggested_name="untitled.ntbk",
                     sources=None):
        self.current_path = None
        return self.save_ntbk(document_json, assets, suggested_name, sources)

    # ── Export and print ───────────────────────
    def export_pdf(self, pages, suggested_name="untitled.pdf", open_after=False):
        """Assemble page PNGs into a PDF.

        The frontend rasterises each A4 page and hands the bytes over, so
        only what is ON a page can ever reach the paper — anything sitting
        out on the canvas is simply never drawn.

        `open_after` hands the finished file to the OS, which is how printing
        works here: the system viewer owns the print dialogue, so the student
        gets their real printer list and "Save as PDF" for free.
        """
        import traceback

        import pymupdf as fitz   # already a dependency, for PDF import

        if not pages:
            return json.dumps({"ok": False, "error": "Nothing to export"})

        try:
            window = self._window()
            # Start in the notebook's own folder. "I saved it and could not
            # find it" is usually the dialog opening somewhere unexpected.
            start_in = os.path.dirname(os.path.abspath(self.current_path)) \
                if self.current_path else os.path.join(os.path.expanduser("~"), "Documents")
            target = window.create_file_dialog(
                webview.SAVE_DIALOG,
                directory=start_in,
                save_filename=suggested_name,
                file_types=("PDF document (*.pdf)",),
            )
            if not target:
                return json.dumps({"ok": False, "cancelled": True})
            path = target if isinstance(target, str) else target[0]
            # macOS hands back an NSString, which is a str SUBCLASS. PyMuPDF
            # tests `type(x) is str`, which a subclass fails — so this saved
            # fine only when the extension had to be appended, because that
            # concatenation happened to produce a real str.
            path = str(path)
            if not path.lower().endswith(".pdf"):
                path += ".pdf"

            # A4 in PDF points, which are 1/72 inch
            a4 = fitz.paper_rect("a4")
            doc = fitz.open()
            try:
                for index, item in enumerate(pages):
                    raw = item.get("png") if isinstance(item, dict) else item
                    if not raw:
                        raise ValueError(f"page {index + 1} arrived with no image")
                    if "," in raw:
                        raw = raw.split(",", 1)[1]
                    image = base64.b64decode(raw)
                    page = doc.new_page(width=a4.width, height=a4.height)
                    page.insert_image(a4, stream=image)
                doc.save(path, deflate=True)
            finally:
                doc.close()

            # Prove it landed. A silent success that writes nothing is the
            # worst outcome of the lot.
            if not os.path.exists(path):
                raise OSError(f"nothing was written to {path}")
            size = os.path.getsize(path)

            if open_after:
                self._open_externally(path)
            else:
                self._reveal(path)      # show the student where it went
            return json.dumps({"ok": True, "path": path,
                               "pages": len(pages), "bytes": size})
        except Exception as error:
            # Print it too, so it is in the log as well as on screen
            traceback.print_exc()
            return json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"})

    def _reveal(self, path):
        """Open a Finder/Explorer window with the file selected."""
        try:
            if sys.platform == "darwin":
                subprocess.Popen(["open", "-R", path])
            elif os.name == "nt":
                subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
            else:
                subprocess.Popen(["xdg-open", os.path.dirname(path)])
        except Exception:
            pass    # the file exists either way

    def _open_externally(self, path):
        """Hand a file to the desktop, whichever desktop this is."""
        try:
            if sys.platform == "darwin":
                subprocess.Popen(["open", path])
            elif os.name == "nt":
                os.startfile(path)      # noqa: S606 - Windows' own opener
            else:
                subprocess.Popen(["xdg-open", path])
        except Exception:
            pass    # the file is written either way; opening it is a courtesy

    # ── Custom shapes ──────────────────────────
    #
    # One file per shape rather than a library database, because that is what
    # makes them draggable between folders in Finder — which is how a student
    # carries them to a new topic.
    def shape_library(self):
        """The personal library: shapes that follow the student, not a file.

        A notebook that has never been saved has no folder to live beside, and
        the scratch directory it used to fall back to is wiped by the OS — so
        shapes made before the first save silently vanished on restart. This
        is a real, visible folder so they survive and can still be dragged.
        """
        folder = os.path.join(os.path.expanduser("~"), "Documents", "ntbk", "shapes")
        os.makedirs(folder, exist_ok=True)
        return folder

    def shape_folders(self):
        """Where shapes are read from: beside this notebook, then the library."""
        folders = []
        if self.current_path:
            folders.append(os.path.join(
                os.path.dirname(os.path.abspath(self.current_path)), "shapes"))
        folders.append(self.shape_library())
        return folders

    def save_shape(self, name, shape_json):
        """Beside the notebook once it has one, otherwise in the library."""
        folder = self.shape_folders()[0]
        os.makedirs(folder, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9 _-]", "", str(name)).strip() or "shape"
        path = os.path.join(folder, f"{safe}.ntbkshape")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(shape_json)
        return json.dumps({"ok": True, "name": safe, "path": path})

    def list_shapes(self):
        """Shapes from this notebook's folder AND the personal library.

        The notebook's own copy wins on a name clash, so dropping a tweaked
        shape next to a file overrides the library one for that topic.
        """
        seen = {}
        for folder in reversed(self.shape_folders()):
            if not os.path.isdir(folder):
                continue
            for entry in sorted(os.listdir(folder)):
                if not entry.endswith(".ntbkshape"):
                    continue
                try:
                    with open(os.path.join(folder, entry), "r", encoding="utf-8") as handle:
                        seen[entry[:-10]] = {"name": entry[:-10], "shape": json.load(handle)}
                except (OSError, ValueError):
                    continue    # a corrupt shape must not break the whole menu
        return json.dumps(list(seen.values()))

    def delete_shape(self, name):
        safe = re.sub(r"[^A-Za-z0-9 _-]", "", str(name)).strip()
        removed = False
        errors = []
        for folder in self.shape_folders():
            path = os.path.join(folder, f"{safe}.ntbkshape")
            if not os.path.exists(path):
                continue
            try:
                os.remove(path)
                removed = True
            except OSError as error:
                errors.append(str(error))
        if removed:
            return json.dumps({"ok": True})
        return json.dumps({"ok": False, "error": errors[0] if errors else "Not found"})

    def take_pending_open(self):
        """The file this window was launched with, handed over exactly once."""
        path, self.pending_open = self.pending_open, None
        if not path:
            return None
        return self._read_ntbk(path)

    def open_ntbk(self):
        window = self._window()
        result = window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("ntbk notebook (*.ntbk)",),
        )
        if not result:
            return None

        path = result if isinstance(result, str) else result[0]
        return self._read_ntbk(path)

    def _read_ntbk(self, path):
        path = str(path)
        assets = {}
        with zipfile.ZipFile(path, "r") as archive:
            document_json = archive.read("document.json").decode("utf-8")
            for name in archive.namelist():
                if name != "document.json" and not name.endswith("/"):
                    assets[name] = base64.b64encode(archive.read(name)).decode("ascii")

        json.loads(document_json)   # reject a corrupt file before the UI sees it
        self.current_path = path
        return json.dumps({"document": document_json, "assets": assets})

    # ── Code cells ─────────────────────────────
    def workdir(self):
        """Where code runs and where mirrored sources live.

        Beside the notebook once it has been saved, so `Thermo.ntbk` gets a
        `Thermo.files/` folder. Before the first save there is nowhere to put
        it, so a scratch folder stands in.
        """
        if self.current_path:
            base = os.path.splitext(self.current_path)[0] + ".files"
            os.makedirs(base, exist_ok=True)
            return base

        if self._scratch is None:
            self._scratch = tempfile.mkdtemp(prefix="ntbk_scratch_")
        return self._scratch

    def workdir_path(self):
        """The folder the notebook itself lives in.

        Shapes go here rather than in `<name>.files/`, so they sit next to the
        .ntbk where the student can see and drag them between topic folders.
        """
        if self.current_path:
            return os.path.dirname(os.path.abspath(self.current_path))
        return self.workdir()

    def _mirror_sources(self, sources):
        if not sources:
            return
        folder = self.workdir()
        for filename, text in sources.items():
            safe = os.path.basename(filename)      # never escape the folder
            if not safe:
                continue
            with open(os.path.join(folder, safe), "w") as handle:
                handle.write(text)

    # ── Terminal, one pty per code cell ──
    #
    #  A real shell rather than captured pipes, so input() shows its prompt
    #  and waits, Ctrl+C interrupts, and ordinary shell commands work. Run
    #  simply types the command for you.
    def term_open(self, cell_id, cols=80, rows=24):
        from services.terminal import TerminalManager
        if self._terminals is None:
            self._terminals = TerminalManager()
        fresh = self._terminals.get(cell_id) is None
        self._terminals.open(cell_id, self.workdir(), cols, rows)

        if fresh:
            # Let the shell finish starting before anything is typed at it.
            # Writing too early gets the command echoed raw and then again by
            # the shell, which is the doubled line you see at the top.
            session = self._terminals.get(cell_id)
            deadline = time.time() + 1.0
            while time.time() < deadline:
                if session.read(0.05):
                    break
        return True

    def term_write(self, cell_id, data):
        session = self._terminals and self._terminals.get(cell_id)
        if session:
            session.write(data)
        return True

    def term_read(self, cell_id):
        """Long-poll: waits briefly for output, then returns what arrived."""
        session = self._terminals and self._terminals.get(cell_id)
        if not session:
            return {"data": "", "done": None, "alive": False}

        raw = session.read().decode("utf-8", "replace")

        # Hold back a few characters so a marker split across two reads is
        # still spotted and still hidden
        raw = getattr(session, "carry", "") + raw
        session.carry = raw[-72:] if len(raw) > 72 else ""
        if session.carry:
            raw = raw[:-len(session.carry)]

        done = None

        # A Run appends an end-marker so we know when that command finished
        # and can look for files it produced.
        #
        # Matched as MARKER:<digits>: rather than on the bare marker, because
        # the shell echoes the line you typed — which contains the marker with
        # a literal $? in it. Matching the bare text declared every run
        # finished the instant it started.
        if session.pending_marker:
            found = re.search(re.escape(session.pending_marker) + r":(\d+):",
                              session.tail)
            if found:
                session.carry = ""
                from services.runner import _collect_artefacts
                done = {
                    "exitCode": int(found.group(1)),
                    "artefacts": _collect_artefacts(self.workdir(),
                                                    session.snapshot or {}),
                }
                session.pending_marker = None
                session.snapshot = None

        # The marker is plumbing, not output — strip it from what the user
        # sees, both where the shell echoed the command and where it printed
        # the result
        if session.marker_pattern:
            raw = session.marker_pattern.sub("", raw)

        return {
            "data": base64.b64encode(raw.encode("utf-8")).decode("ascii"),
            "done": done,
            "alive": session.alive(),
        }

    def term_run(self, cell_id, command):
        """Type a command into the cell's shell and watch for it to finish."""
        from services.terminal import make_marker, _snapshot_dir
        session = self._terminals and self._terminals.get(cell_id)
        if not session:
            return False
        marker = make_marker()
        session.pending_marker = marker
        session.marker_pattern = re.compile(
            r"(;\s*echo\s+)?" + re.escape(marker) + r":[^:]*:\s*")
        session.snapshot = _snapshot_dir(self.workdir())
        session.tail = ""
        session.write(f"{command}; echo {marker}:$?:\n")
        return True

    def save_source(self, filename, source):
        """Write one cell's file, so the terminal runs what the editor shows."""
        self._mirror_sources({filename: source})
        return os.path.join(self.workdir(), os.path.basename(filename))

    def term_interrupt(self, cell_id, hard=False):
        """Ctrl+C, or SIGKILL the whole group if that wasn't enough."""
        session = self._terminals and self._terminals.get(cell_id)
        if not session:
            return False
        if hard:
            import signal
            try:
                os.killpg(os.getpgid(session.process.pid), signal.SIGKILL)
            except Exception:
                return False
            return True
        session.write("\x03")
        return True

    def term_resize(self, cell_id, cols, rows):
        session = self._terminals and self._terminals.get(cell_id)
        if session:
            session.resize(cols, rows)
        return True

    def term_close(self, cell_id):
        if self._terminals:
            self._terminals.close(cell_id)
        return True

    def run_code(self, filename, source, stdin_text=""):
        """Kept for the non-interactive path; the terminal is the main one."""
        from services.runner import run_code as run
        return run(filename, source, stdin_text, workdir=self.workdir())

    def code_languages(self):
        from services.runner import available_languages
        return available_languages()

    def reveal_workdir(self):
        """Open the folder in Finder, so the mirrored files are easy to find."""
        folder = self.workdir()
        subprocess.Popen(["open", folder])
        return folder

    # ── Importing media ────────────────────────
    def pick_files(self, accept="image/*", multiple=False):
        """Native picker. `accept` mirrors the HTML input attribute."""
        window = self._window()
        filters = {
            "image/*": ("Images (*.png;*.jpg;*.jpeg;*.gif;*.webp)",),
            "application/pdf": ("PDF (*.pdf)",),
            "video/*": ("Video (*.mp4;*.webm;*.mov)",),
            "audio/*": ("Audio (*.mp3;*.wav;*.m4a;*.aac)",),
        }.get(accept, ("All files (*.*)",))

        result = window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=multiple, file_types=filters)
        if not result:
            return []
        return list(result) if not isinstance(result, str) else [result]

    def read_file(self, path):
        """Read a file off disk for the frontend to take ownership of."""
        if not os.path.isfile(path):
            return None
        mime, _ = mimetypes.guess_type(path)
        with open(path, "rb") as handle:
            data = base64.b64encode(handle.read()).decode("ascii")
        return {
            "name": os.path.basename(path),
            "mime": mime or "application/octet-stream",
            "data": data,
        }

    # ── PDF rasterising ────────────────────────
    #
    #  Done here rather than with pdf.js in the frontend. pdf.js opens a
    #  document and reads its pages fine, but page.render() never settles —
    #  no error, no failed request — in both Chromium and WKWebView. MuPDF
    #  renders the same file in about 30ms.
    #
    #  The frontend still owns layout, placement and annotation; this only
    #  turns a page into pixels.
    def pdf_open(self, asset_id, data_b64):
        """Open once and keep it, so the bytes only cross the bridge a single time."""
        import pymupdf

        if asset_id not in self._pdfs:
            self._pdfs[asset_id] = pymupdf.open(
                stream=base64.b64decode(data_b64), filetype="pdf")

        document = self._pdfs[asset_id]
        return {
            "pages": document.page_count,
            "sizes": [[page.rect.width, page.rect.height] for page in document],
        }

    def pdf_render(self, asset_id, page_number, width_px):
        """One page as a PNG, rendered to fit `width_px` across."""
        import pymupdf

        document = self._pdfs.get(asset_id)
        if document is None or not (1 <= page_number <= document.page_count):
            return None

        page = document[page_number - 1]
        width = max(32, min(int(width_px), 4000))     # no poster-sized pixmaps
        zoom = width / page.rect.width
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        return base64.b64encode(pixmap.tobytes("png")).decode("ascii")

    def pdf_close(self, asset_id):
        document = self._pdfs.pop(asset_id, None)
        if document is not None:
            document.close()
        return True

    # ── Toolchain detection, for the code cells that come later ──
    def detect_toolchains(self):
        from shutil import which
        return {
            name: which(binary) is not None
            for name, binary in (
                ("python", "python3"),
                ("c", "gcc"),
                ("cpp", "g++"),
                ("java", "javac"),
                ("latex", "pdflatex"),
            )
        }
