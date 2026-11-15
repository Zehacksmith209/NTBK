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
# ─────────────────────────────────────────────
#  SETTINGS
#
#  One small file for the handful of choices
#  that have to outlive a run. Deliberately not
#  in the shape library itself — that is the very
#  thing the student can move.
# ─────────────────────────────────────────────
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".ntbk.json")


def default_shape_library():
    return os.path.join(os.path.expanduser("~"), "Documents", "ntbk", "shapes")


def formulas_path():
    return os.path.join(os.path.dirname(default_shape_library()), "formulas.json")


def read_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}      # missing or corrupt settings must never block startup


def write_config(data):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=1)
        return True
    except OSError:
        return False


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
        self._companion = None   # LAN server, only while companion mode is on

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

        The student can point this somewhere else — a Dropbox folder, a USB
        stick, a shared class folder. If that location is gone when the app
        next starts (drive unplugged, folder deleted) we fall back to the
        default rather than failing, so the library is never unreachable.
        """
        chosen = read_config().get("shape_library")
        if chosen and os.path.isdir(chosen):
            return chosen
        folder = default_shape_library()
        os.makedirs(folder, exist_ok=True)
        return folder

    def choose_shape_library(self):
        """Ask for a folder and read shapes from there from now on."""
        window = self._window()
        try:
            result = window.create_file_dialog(
                webview.FOLDER_DIALOG, directory=self.shape_library())
        except Exception as error:
            return json.dumps({"ok": False, "error": str(error)})
        if not result:
            return json.dumps({"ok": False, "cancelled": True})

        # macOS hands back an NSString subclass, which is not `str` as far as
        # an `is str` check is concerned — the same trap that silently broke
        # PDF saving. Normalise it once, here.
        path = str(result if isinstance(result, (str, os.PathLike)) else result[0])
        if not os.path.isdir(path):
            return json.dumps({"ok": False, "error": "That is not a folder"})

        config = read_config()
        config["shape_library"] = path
        if not write_config(config):
            return json.dumps({"ok": False, "error": "Could not save that choice"})
        return json.dumps({"ok": True, "folder": path})

    # ── Companion mode ────────────────────────
    #
    #  Off by default, started only by an explicit menu action, and gated by
    #  a six-digit code shown on this machine. Nothing here is reachable by
    #  accident.
    def companion_start(self):
        try:
            from services.companion import Companion
            if self._companion is None:
                # HERE lives in app.py, not here. Derive it from this file.
                # Same two worlds as app.py: inside a .app the source tree
                # does not exist and the files live where PyInstaller put them.
                base = getattr(sys, "_MEIPASS", None)
                dist = (os.path.join(base, "frontend", "dist") if base
                        else os.path.normpath(os.path.join(
                            os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "dist")))
                if not os.path.isdir(dist):
                    return json.dumps({"running": False,
                                       "error": f"frontend/dist not found at {dist} — run npm run build"})
                self._companion = Companion(dist, on_command=self._companion_command)
            return json.dumps(self._companion.start())
        except Exception as error:
            # Reported, never swallowed. A student who cannot see why this
            # failed has no way to fix it, and "could not start" is not a
            # reason — it is the absence of one.
            traceback.print_exc()
            return json.dumps({"running": False,
                               "error": f"{type(error).__name__}: {error}"})

    def companion_stop(self):
        if self._companion:
            self._companion.stop()
        return json.dumps({"ok": True, "running": False})

    def companion_status(self):
        if not self._companion:
            return json.dumps({"running": False})
        return json.dumps(self._companion.info())

    def companion_set_document(self, document_json):
        """The laptop pushes a snapshot for new clients to pull.

        Opaque on this side, exactly as save_ntbk has always treated it.
        """
        if self._companion:
            self._companion.set_document(document_json)
        return True

    def companion_broadcast(self, message_json):
        """Laptop -> every paired device."""
        if self._companion:
            self._companion.broadcast(json.loads(message_json))
        return True

    def companion_allow_code(self, allow):
        """Whether a paired device may run code cells.

        Its own decision, never an implied consequence of pairing: a token
        that can run code is a token that can run anything on this machine.
        """
        if self._companion:
            self._companion.allow_code_execution = bool(allow)
        return json.dumps(self._companion.info() if self._companion else {})

    def _companion_command(self, command):
        """A command arrived from a paired device.

        Pushed into the laptop's own frontend, which is the authority — it
        applies the command and re-broadcasts, exactly as if the edit had
        been made here.
        """
        window = self._window()
        if not window:
            return
        try:
            window.evaluate_js(
                f"window.ntbkCompanion && window.ntbkCompanion.receive({json.dumps(command)})")
        except Exception:
            traceback.print_exc()

    # ── Formula library ───────────────────────
    #
    #  One file beside the shape library, so the student's formulas follow
    #  them from notebook to notebook. Opaque here: the frontend owns the
    #  shape of the data, and this side only keeps it safe on disk.
    def get_formulas(self):
        try:
            with open(formulas_path(), "r", encoding="utf-8") as handle:
                return handle.read()
        except OSError:
            return ""           # no library yet, which is not an empty one

    def save_formulas(self, text):
        try:
            json.loads(text)    # never replace a good file with a broken one
            path = formulas_path()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            # Written beside the real file and swapped in, so a crash halfway
            # through cannot leave the library truncated.
            partial = path + ".part"
            with open(partial, "w", encoding="utf-8") as handle:
                handle.write(text)
            os.replace(partial, path)
            return json.dumps({"ok": True, "path": path})
        except (OSError, ValueError) as error:
            return json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"})

    def open_url(self, url):
        """Open a web address in the system browser.

        Only http and https. This is reachable from page script, and anything
        else handed to the desktop's opener — a file path, a custom scheme —
        would be asking the operating system to run it.
        """
        import webbrowser
        url = str(url).strip()
        if not re.match(r"^https?://", url, re.IGNORECASE):
            return False
        try:
            return bool(webbrowser.open(url))
        except Exception:
            return False

    def get_pointer_offset(self):
        """How far to shift incoming stylus coordinates.

        Zero means "trust the OS", which is right everywhere except on a
        display stack that is lying about where the pen is.
        """
        config = read_config()
        active = config.get("pointerOffset") or {"x": 0, "y": 0}
        saved = config.get("pointerOffsetSaved") or {"x": 0, "y": 0}
        return json.dumps({"active": active, "saved": saved})

    def set_pointer_offset(self, x, y, remember=True):
        config = read_config()
        offset = {"x": float(x), "y": float(y)}
        config["pointerOffset"] = offset
        # A non-zero setting is also kept as the "reinforced" preset, so
        # flipping back to System Original does not throw away the numbers
        # the student worked out by hand.
        if remember and (offset["x"] or offset["y"]):
            config["pointerOffsetSaved"] = offset
        write_config(config)
        return json.dumps({"active": offset,
                           "saved": config.get("pointerOffsetSaved") or {"x": 0, "y": 0}})

    def get_theme(self):
        """"light" or "dark" — remembered between runs."""
        value = read_config().get("theme")
        return value if value in ("light", "dark") else "light"

    def set_theme(self, theme):
        if theme not in ("light", "dark"):
            return json.dumps({"ok": False, "error": "unknown theme"})
        config = read_config()
        config["theme"] = theme
        write_config(config)
        return json.dumps({"ok": True, "theme": theme})

    def reset_shape_library(self):
        """Go back to the default folder."""
        config = read_config()
        config.pop("shape_library", None)
        write_config(config)
        return json.dumps({"ok": True, "folder": self.shape_library()})

    def shape_folders(self):
        """Where shapes are read from: beside this notebook, then the library."""
        folders = []
        if self.current_path:
            folders.append(os.path.join(
                os.path.dirname(os.path.abspath(self.current_path)), "shapes"))
        folders.append(self.shape_library())
        return folders

    def save_shape(self, name, shape_json):
        """Always into the personal library.

        It used to save beside the notebook whenever there was one, which
        meant where a shape landed depended on which file happened to be open
        when you pressed save — so a shape saved while working on one topic
        was simply absent from the next, with nothing to explain why. A shape
        library is a property of the person, not of a document.

        Reading still merges the notebook's own `shapes/` folder on top of
        this one (see list_shapes), so anything already sitting beside a
        notebook keeps working and can still override a library shape of the
        same name.
        """
        folder = self.shape_library()
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
