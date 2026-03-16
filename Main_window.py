import sys
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QToolBar, QWidget,
    QVBoxLayout, QGraphicsScene, QGraphicsView, QLabel,
    QSizePolicy, QToolButton, QMenu, QWidgetAction, QComboBox, QSpinBox
)
from PyQt6.QtGui import QAction, QIcon, QColor, QPainter, QCursor
from PyQt6.QtCore import Qt, QSize

from Canvas_base import Canvas


# ─────────────────────────────────────────────
#  MAIN WINDOW
# ─────────────────────────────────────────────
class NtbkApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("ntbk")
        self.setMinimumSize(1200, 800)#this says the window cannot be smaller than 1200x800
        self.setStyleSheet("background-color: #f0f0f0;")

        # Canvas is the central widget everything is built around
        self.canvas = Canvas()
        self.setCentralWidget(self.canvas)

        # Build each toolbar
        self._build_file_toolbar()
        self._build_home_toolbar()
        self._build_insert_toolbar()

    # ── Toolbar helper ──────────────────────────────────
    def _make_toolbar(self, title):
        """Creates a styled toolbar and adds it to the window."""
        tb = QToolBar(title)
        tb.setMovable(False)
        tb.setIconSize(QSize(24, 24))
        tb.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextUnderIcon)
        tb.setStyleSheet("""
            QToolBar {
                background: #000000;
                border-bottom: 1px solid #cccccc;
                spacing: 4px;
                padding: 4px 8px;
            }
            QToolButton {
                background: transparent;
                border: 1px solid transparent;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 11px;
                min-width: 48px;
            }
            QToolButton:hover {
                background: #d0d0d0;
                border: 1px solid #bbbbbb;
            }
            QToolButton:pressed {
                background: #c0c0c0;
            }
            QToolButton::menu-indicator {
                image: none;
            }
        """)
        self.addToolBar(tb)
        return tb

    def _separator(self, toolbar):
        """Adds a visual separator between button groups."""
        sep = QWidget()
        sep.setFixedWidth(1)
        sep.setStyleSheet("background-color: #FF0000; margin: 4px 6px;")
        toolbar.addWidget(sep)

    def _make_button(self, toolbar, label, tooltip, slot=None):
        """Creates a simple toolbar button."""
        btn = QToolButton()
        btn.setText(label)
        btn.setToolTip(tooltip)
        btn.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        if slot:
            btn.clicked.connect(slot)
        toolbar.addWidget(btn)
        return btn

    def _make_dropdown_button(self, toolbar, label, tooltip, menu_items):
        """Creates a toolbar button with a dropdown menu."""
        btn = QToolButton()
        btn.setText(label)
        btn.setToolTip(tooltip)
        btn.setPopupMode(QToolButton.ToolButtonPopupMode.MenuButtonPopup)
        btn.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))

        menu = QMenu()
        for item_label, slot in menu_items:
            action = QAction(item_label, self)
            if slot:
                action.triggered.connect(slot)
            menu.addAction(action)

        btn.setMenu(menu)
        toolbar.addWidget(btn)
        return btn

    # ── FILE toolbar ─────────────────────────────────────
    def _build_file_toolbar(self):
        tb = self._make_toolbar("File")

        self._make_button(tb, "💾  Save",      "Save as .ntbk",        self._on_save)
        self._make_button(tb, "📄  Save PDF",  "Export as PDF",         self._on_save_pdf)
        self._make_button(tb, "🖨  Print",     "Print",                 self._on_print)

        self._separator(tb)

        self._make_button(tb, "☁️  Upload",   "Upload to cloud",       self._on_cloud_upload)

    # ── HOME toolbar ─────────────────────────────────────
    def _build_home_toolbar(self):
        tb = self._make_toolbar("Home")

        # Pens group
        self._make_dropdown_button(tb, "🖊  Pen", "Pen tool", [
            ("Pen Color",     self._on_pen_color),
            ("Pen Thickness", self._on_pen_thickness),
        ])
        self._make_dropdown_button(tb, "🟡  Highlighter", "Highlighter tool", [
            ("Highlight Color",     self._on_highlight_color),
            ("Highlight Thickness", self._on_highlight_thickness),
        ])

        self._separator(tb)

        # Eraser group
        self._make_dropdown_button(tb, "⬜  Eraser", "Eraser tool", [
            ("Eraser Thickness", self._on_eraser_thickness),
            ("Partial Erase",    self._on_eraser_partial),
            ("Erase Whole",      self._on_eraser_whole),
        ])

        self._separator(tb)

        # Shapes group
        self._make_dropdown_button(tb, "🔷  Shapes", "Shape input", [
            ("Triangle",         self._on_shape_triangle),
            ("Circle",           self._on_shape_circle),
            ("Rectangle",        self._on_shape_rect),
            ("X-Y Plane (2D)",   self._on_shape_xy),
            ("X-Y-Z Plane (3D)", self._on_shape_xyz),
        ])

        self._separator(tb)

        # Text input
        self._make_button(tb, "T  Text", "Text input", self._on_text_input)

    # ── INSERT toolbar ────────────────────────────────────
    def _build_insert_toolbar(self):
        tb = self._make_toolbar("Insert")

        self._make_button(tb, "🖼  Picture",     "Insert image",          self._on_insert_picture)

        self._separator(tb)

        self._make_dropdown_button(tb, "📎  File", "Insert file", [
            ("Insert PDF Printout",   self._on_insert_pdf),
            ("Insert Excel File",     self._on_insert_excel),
        ])

        self._separator(tb)

        self._make_button(tb, "⊞  Table",       "Insert table",          self._on_insert_table)
        self._make_button(tb, "∑  LaTeX",        "Insert LaTeX box",      self._on_insert_latex)

        self._separator(tb)

        self._make_dropdown_button(tb, "</>  Code", "Insert code box", [
            ("Python",     lambda: self._on_insert_code("Python")),
            ("C++",        lambda: self._on_insert_code("C++")),
            ("C",          lambda: self._on_insert_code("C")),
            ("Java",       lambda: self._on_insert_code("Java")),
            ("JavaScript", lambda: self._on_insert_code("JavaScript")),
        ])

        self._separator(tb)

        self._make_dropdown_button(tb, "📈  Graph", "Insert graph", [
            ("Matplotlib Graph", self._on_insert_matplotlib),
            ("Desmos Graph",     self._on_insert_desmos),
        ])

    # ── Placeholder slots ─────────────────────────────────
    # These are all empty for now — each one will be wired up
    # as we build each feature out one by one.

    def _on_save(self):             print("Save")
    def _on_save_pdf(self):         print("Save PDF")
    def _on_print(self):            print("Print")
    def _on_cloud_upload(self):     print("Cloud Upload")

    def _on_pen_color(self):        
        # Temporary: cycles black → blue to test color switching
        # Will be replaced with a proper color picker dialog later
        if self.canvas.pen_color == QColor("#000000"):
            self.canvas.set_pen_color(QColor("#1a6ef5"))
            print("Pen color → blue")
        else:
            self.canvas.set_pen_color(QColor("#000000"))
            print("Pen color → black")
    def _on_pen_thickness(self):    
        # Temporary: cycles thin → thick to test thickness switching
        # Will be replaced with a slider dialog later
        if self.canvas.pen_width == 2.0:
            self.canvas.set_pen_width(6.0)
            print("Pen width → thick")
        else:
            self.canvas.set_pen_width(2.0)
            print("Pen width → thin")
    def _on_highlight_color(self):  print("Highlight Color")
    def _on_highlight_thickness(self): print("Highlight Thickness")

    def _on_eraser_thickness(self): print("Eraser Thickness")
    def _on_eraser_partial(self):   print("Partial Erase")
    def _on_eraser_whole(self):     print("Erase Whole")

    def _on_shape_triangle(self):   print("Shape: Triangle")
    def _on_shape_circle(self):     print("Shape: Circle")
    def _on_shape_rect(self):       print("Shape: Rectangle")
    def _on_shape_xy(self):         print("Shape: XY Plane")
    def _on_shape_xyz(self):        print("Shape: XYZ Plane")

    def _on_text_input(self):       print("Text Input")

    def _on_insert_picture(self):   print("Insert Picture")
    def _on_insert_pdf(self):       print("Insert PDF")
    def _on_insert_excel(self):     print("Insert Excel")
    def _on_insert_table(self):     print("Insert Table")
    def _on_insert_latex(self):     print("Insert LaTeX")
    def _on_insert_code(self, lang): print(f"Insert Code: {lang}")
    def _on_insert_matplotlib(self): print("Insert Matplotlib")
    def _on_insert_desmos(self):    print("Insert Desmos")