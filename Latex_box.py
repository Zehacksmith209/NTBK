import os
import shutil
import subprocess
import tempfile

import numpy as np

from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPlainTextEdit, QLabel, QToolButton,
    QDialog, QDialogButtonBox, QGraphicsPixmapItem, QGraphicsItem
)
from PyQt6.QtGui import QPixmap, QImage, QFont
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QSize
from PyQt6.QtPdf import QPdfDocument


# ─────────────────────────────────────────────
#  LATEX SETTINGS
# ─────────────────────────────────────────────
LATEX_BINARY    = "pdflatex"
COMPILE_TIMEOUT = 20      # seconds — stops a runaway macro hanging the app
RENDER_DPI      = 300     # rasterise well above display size, so scaling up
DISPLAY_DPI     = 120     # still looks sharp
DISPLAY_SCALE   = DISPLAY_DPI / RENDER_DPI

# Wrapped around whatever you type. The standalone class crops the page down to
# the content, and varwidth stops display maths stretching to a full text width.
DEFAULT_PREAMBLE = r"""\documentclass[preview,border=1pt,varwidth]{standalone}
\usepackage{amsmath,amssymb}
\usepackage{tikz}"""

DEFAULT_SOURCE = r"\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"


def _extract_error(log_path):
    """Pull the actual complaint out of a LaTeX log.

    LaTeX logs are hundreds of lines of noise around a handful of lines that
    matter — the ones starting with '!' and the 'l.<n>' line pointing at the
    offending input.
    """
    try:
        with open(log_path, "r", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return ""

    out = []
    for i, line in enumerate(lines):
        if line.startswith("!") or line.startswith("l."):
            out.extend(lines[i:i + 3])
            out.append("")
        if len(out) > 24:
            break
    return "\n".join(out).strip()


def build_document(source, preamble):
    """Wrap a snippet into a compilable document.

    Bare maths like \\frac{a}{b} has to be in math mode to compile, but an
    align block or a tikzpicture brings its own environment — wrapping those
    would break them, so only wrap when there's no sign of one.
    """
    body = source.strip()
    if not body:
        return None

    if not ("$" in body or "\\begin{" in body or "\\[" in body):
        # Inline math with \displaystyle rather than \[ ... \]: renders at
        # display size without forcing a full-width paragraph
        body = "$\\displaystyle " + body + "$"

    return (f"{preamble}\n"
            f"\\begin{{document}}\n{body}\n\\end{{document}}\n")


# ─────────────────────────────────────────────
#  WHITE BACKGROUND → TRANSPARENCY
#  A PDF page renders on white paper. Dropped
#  on the canvas as-is, that white rectangle
#  hides anything underneath it, which is what
#  makes a formula look like a pasted box
#  instead of writing on the page.
# ─────────────────────────────────────────────
def _white_to_alpha(image):
    """Turn a white-backed render into transparent-backed glyphs.

    Alpha comes from how far each pixel is from white, then the colour is
    un-mixed from the white it was composited over. Doing it this way keeps
    anti-aliased edges smooth (a plain colour-key would leave white fringes)
    and keeps coloured maths the right colour.
    """
    image  = image.convertToFormat(QImage.Format.Format_ARGB32)
    width  = image.width()
    height = image.height()
    stride = image.bytesPerLine()

    ptr = image.bits()
    ptr.setsize(height * stride)
    pixels = np.frombuffer(ptr, dtype=np.uint8).reshape(height, stride // 4, 4)
    pixels = pixels[:, :width, :].astype(np.float32)

    # Qt's ARGB32 is laid out B, G, R, A in memory on this platform
    blue, green, red = pixels[..., 0], pixels[..., 1], pixels[..., 2]

    alpha = 255.0 - np.minimum(np.minimum(blue, green), red)
    out   = np.zeros((height, width, 4), dtype=np.float32)
    lit   = alpha > 0

    for index, channel in enumerate((blue, green, red)):
        recovered = np.zeros_like(channel)
        # observed = alpha*colour + (1-alpha)*white, solved for colour
        recovered[lit] = ((channel[lit] - (255.0 - alpha[lit]))
                          * 255.0 / alpha[lit])
        out[..., index] = np.clip(recovered, 0, 255)
    out[..., 3] = alpha

    data = out.astype(np.uint8).tobytes()
    # .copy() so the QImage owns its pixels rather than referencing `data`
    return QImage(data, width, height, width * 4,
                  QImage.Format.Format_ARGB32).copy()


def pixmap_from_pdf(pdf_path):
    """Rasterise page 1 of the PDF, background removed."""
    document = QPdfDocument(None)   # PyQt6 requires the parent argument
    document.load(pdf_path)
    if document.pageCount() < 1:
        raise RuntimeError("LaTeX produced an empty PDF.")

    point_size = document.pagePointSize(0)
    scale = RENDER_DPI / 72.0       # PDF points are 1/72 inch
    size = QSize(max(1, int(point_size.width()  * scale)),
                 max(1, int(point_size.height() * scale)))

    return QPixmap.fromImage(_white_to_alpha(document.render(0, size)))


# ─────────────────────────────────────────────
#  COMPILE WORKER
#  pdflatex runs off the UI thread — a tikz
#  picture can take seconds, and doing that
#  inline would freeze the whole app.
# ─────────────────────────────────────────────
class _CompileWorker(QThread):
    # ok, pdf path, error text
    done = pyqtSignal(bool, str, str)

    def __init__(self, tex_source, parent=None):
        super().__init__(parent)
        self.tex_source = tex_source

    def run(self):
        workdir  = tempfile.mkdtemp(prefix="ntbk_latex_")
        tex_path = os.path.join(workdir, "box.tex")
        pdf_path = os.path.join(workdir, "box.pdf")
        log_path = os.path.join(workdir, "box.log")

        with open(tex_path, "w") as f:
            f.write(self.tex_source)

        try:
            proc = subprocess.run(
                [LATEX_BINARY,
                 "-interaction=nonstopmode",
                 "-halt-on-error",
                 "-no-shell-escape",   # never let the document run shell commands
                 "box.tex"],
                cwd=workdir, capture_output=True, text=True,
                timeout=COMPILE_TIMEOUT)
        except subprocess.TimeoutExpired:
            shutil.rmtree(workdir, ignore_errors=True)
            self.done.emit(False, "", f"LaTeX timed out after {COMPILE_TIMEOUT}s.")
            return
        except FileNotFoundError:
            shutil.rmtree(workdir, ignore_errors=True)
            self.done.emit(False, "", f"'{LATEX_BINARY}' not found on this machine.")
            return

        if proc.returncode != 0 or not os.path.exists(pdf_path):
            message = _extract_error(log_path) or (proc.stdout or "")[-1200:]
            shutil.rmtree(workdir, ignore_errors=True)
            self.done.emit(False, "", message or "LaTeX failed with no output.")
            return

        # Caller renders the PDF and then deletes the directory
        self.done.emit(True, pdf_path, "")


# ─────────────────────────────────────────────
#  LATEX ITEM
#  What actually lives on the canvas: the
#  typeset output and nothing else. The source
#  rides along on the item so it can be
#  reopened and edited.
# ─────────────────────────────────────────────
class LatexItem(QGraphicsPixmapItem):
    def __init__(self, source=None, preamble=None):
        super().__init__()
        self.source   = source if source is not None else DEFAULT_SOURCE
        self.preamble = preamble if preamble is not None else DEFAULT_PREAMBLE

        self.setTransformationMode(Qt.TransformationMode.SmoothTransformation)
        self.setScale(DISPLAY_SCALE)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)


# ─────────────────────────────────────────────
#  PREAMBLE DIALOG
# ─────────────────────────────────────────────
class _PreambleDialog(QDialog):
    def __init__(self, preamble, parent=None):
        super().__init__(parent)
        self.setWindowTitle("LaTeX Preamble")
        self.resize(520, 300)

        self.editor = QPlainTextEdit(preamble)
        self.editor.setFont(QFont("Menlo", 12))

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok |
            QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("Everything before \\begin{document}:"))
        layout.addWidget(self.editor)
        layout.addWidget(buttons)

    def preamble(self):
        return self.editor.toPlainText()


# ─────────────────────────────────────────────
#  FLOATING SOURCE EDITOR
#  Appears next to the formula on demand and
#  goes away again, so it never permanently
#  occupies canvas space.
# ─────────────────────────────────────────────
class LatexEditor(QWidget):
    WIDTH  = 380
    HEIGHT = 210

    def __init__(self, canvas, item):
        # Parented to the viewport so it floats above the canvas contents
        super().__init__(canvas.viewport())
        self.canvas  = canvas
        self.item    = item
        self._worker = None

        self.setFixedSize(self.WIDTH, self.HEIGHT)
        self.setAutoFillBackground(True)
        self.setStyleSheet("""
            QWidget      { background: #f0f0f0; border: 1px solid #808080; }
            QPlainTextEdit { background: #ffffff; border: 1px solid #bbbbbb; }
            QLabel       { border: none; }
            QToolButton  { border: 1px solid #bbbbbb; border-radius: 3px;
                           padding: 2px 8px; background: #fafafa; }
            QToolButton:hover { background: #e0e0e0; }
        """)

        title = QLabel("LaTeX")
        title.setStyleSheet("font-weight: bold; border: none;")

        preamble_btn = QToolButton()
        preamble_btn.setText("Preamble…")
        preamble_btn.clicked.connect(self._edit_preamble)

        close_btn = QToolButton()
        close_btn.setText("✕")
        close_btn.setToolTip("Close editor")
        close_btn.clicked.connect(self.close_editor)

        header = QHBoxLayout()
        header.addWidget(title)
        header.addStretch()
        header.addWidget(preamble_btn)
        header.addWidget(close_btn)

        self.editor = QPlainTextEdit(item.source)
        self.editor.setFont(QFont("Menlo", 12))

        self.status = QLabel("")
        self.status.setWordWrap(True)
        self.status.setStyleSheet("color: #666666; border: none;")

        render_btn = QToolButton()
        render_btn.setText("Render  (⌘↩)")
        render_btn.clicked.connect(self.render_now)

        footer = QHBoxLayout()
        footer.addWidget(self.status, 1)
        footer.addWidget(render_btn)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(6, 6, 6, 6)
        layout.addLayout(header)
        layout.addWidget(self.editor)
        layout.addLayout(footer)

        self.editor.setFocus()

    # ── Placement ───────────────────────────────────────
    def place_near_item(self):
        """Sit just under the formula, nudged back inside the viewport."""
        corner = self.canvas.mapFromScene(self.item.sceneBoundingRect().bottomLeft())
        x, y = corner.x(), corner.y() + 10

        bounds = self.canvas.viewport().rect()
        x = max(4, min(x, bounds.width()  - self.WIDTH  - 4))
        y = max(4, min(y, bounds.height() - self.HEIGHT - 4))
        self.move(int(x), int(y))

    # ── Editing ─────────────────────────────────────────
    def _edit_preamble(self):
        dialog = _PreambleDialog(self.item.preamble, self)
        if dialog.exec():
            self.item.preamble = dialog.preamble()
            self.render_now()

    def keyPressEvent(self, event):
        # Cmd+Return renders without reaching for the mouse
        if (event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter)
                and event.modifiers() & Qt.KeyboardModifier.ControlModifier):
            self.render_now()
            return
        super().keyPressEvent(event)

    def close_editor(self):
        self.hide()
        self.deleteLater()
        if getattr(self.canvas, "latex_editor", None) is self:
            self.canvas.latex_editor = None

    # ── Rendering ───────────────────────────────────────
    def render_now(self):
        if self._worker is not None and self._worker.isRunning():
            return   # one compile at a time

        if shutil.which(LATEX_BINARY) is None:
            self._set_status(f"'{LATEX_BINARY}' not found — "
                             "install TeX (brew install texlive).", error=True)
            return

        source   = self.editor.toPlainText()
        document = build_document(source, self.item.preamble)
        if document is None:
            self._set_status("Nothing to render.", error=True)
            return

        self.item.source = source
        self._set_status("Rendering…")

        self._worker = _CompileWorker(document, self)
        self._worker.done.connect(self._on_compiled)
        self._worker.start()

    def _on_compiled(self, ok, pdf_path, error_text):
        if not ok:
            self._set_status(error_text.strip().splitlines()[0]
                             if error_text.strip() else "LaTeX failed.",
                             error=True)
            return

        workdir = os.path.dirname(pdf_path)
        try:
            pixmap = pixmap_from_pdf(pdf_path)
        except Exception as err:
            self._set_status(f"Could not render PDF: {err}", error=True)
            return
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

        self.item.setPixmap(pixmap)
        self._set_status("Rendered.")

    def _set_status(self, text, error=False):
        self.status.setStyleSheet(
            f"color: {'#c00000' if error else '#666666'}; border: none;")
        self.status.setText(text)
