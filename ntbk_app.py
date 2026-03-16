import sys
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QToolBar, QWidget,
    QVBoxLayout, QGraphicsScene, QGraphicsView, QLabel,
    QSizePolicy, QToolButton, QMenu, QWidgetAction, QComboBox, QSpinBox
)
from PyQt6.QtGui import QAction, QIcon, QColor, QPainter, QCursor
from PyQt6.QtCore import Qt, QSize

from Canvas_base import Canvas
from Main_window import NtbkApp


# ─────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────
if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setStyle("Fusion")    # Consistent cross-platform look
    window = NtbkApp()
    window.show()
    sys.exit(app.exec())
