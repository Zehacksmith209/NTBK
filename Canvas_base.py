import sys
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QToolBar, QWidget,
    QVBoxLayout, QGraphicsScene, QGraphicsView, QLabel,
    QSizePolicy, QToolButton, QMenu, QWidgetAction, QComboBox, QSpinBox
)
from PyQt6.QtGui import QAction, QIcon, QColor, QPainter, QCursor, QPainterPath, QPen
from PyQt6.QtCore import Qt, QSize







# ─────────────────────────────────────────────
#  CANVAS
#  This is the main drawing area — built on
#  QGraphicsScene/QGraphicsView which will
#  later handle drawing, shapes, images etc.
# ─────────────────────────────────────────────


class Canvas(QGraphicsView):
    def __init__(self):
        super().__init__()
        self.scene = QGraphicsScene()#this is where all the drawings are stored, sort of like paper
        self.scene.setSceneRect(0, 0, 1200, 900)   # A4-ish canvas size
        self.setScene(self.scene)

        self.setRenderHint(QPainter.RenderHint.Antialiasing)#for smooth pen strokes, not pixelated like microsoft paint
        self.setBackgroundBrush(QColor("#ffffff"))  # White canvas
        self.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)

        # This will later switch between draw / select / text etc.
        self.current_tool = "pen"


        #Tool settings like pen size, color etc. will go here
        self.pen_color = QColor("#000000")  # Default black pen
        self.pen_size = 2

        #----Stroke Tracking-----
        #These three variables track the stroke currently being drawn
        #They reset to None after every stroke is completed
        self.current_path = None # QPainterPath being built point by point
        self.current_path_item = None # live item sitting on the scene/canvas
        
        self.last_point = None     # Last mouse position, for smooth lines


        self.stylus_pressure  = 1.0     # 0.0 → 1.0, defaults to full
        self.is_stylus_active = False   # flips True when tablet events arrive


    # ─────────────────────────────────────────
    #  TABLET (STYLUS) EVENTS
    #  Fires for Wacom or Apple Pencil via Sidecar.
    #  Gives pressure + tilt — mouse events don't have these.
    # ─────────────────────────────────────────
    def tabletEvent(self, event):
        scene_pos = self.mapToScene(event.position().toPoint())
 
        if event.type() == event.Type.TabletPress:
            self.is_stylus_active = True
            self.stylus_pressure  = event.pressure()
            self._start_stroke(scene_pos)
 
        elif event.type() == event.Type.TabletMove:
            self.stylus_pressure = event.pressure()
            self._continue_stroke(scene_pos)
 
        elif event.type() == event.Type.TabletRelease:
            self._end_stroke()
            self.is_stylus_active = False
            self.stylus_pressure  = 1.0
 
        # Accepting stops Qt from firing a duplicate mouse event on top of this
        event.accept()



    # ─────────────────────────────────────────
    #  MOUSE EVENTS
    #  Guards check is_stylus_active so stylus
    #  and mouse don't both draw at the same time.
    # ─────────────────────────────────────────
    def mousePressEvent(self, event):
        if self.is_stylus_active:
            return
        if event.button() == Qt.MouseButton.LeftButton:
            scene_pos = self.mapToScene(event.position().toPoint())
            self._start_stroke(scene_pos)
 
    def mouseMoveEvent(self, event):
        if self.is_stylus_active:
            return
        if event.buttons() & Qt.MouseButton.LeftButton:
            scene_pos = self.mapToScene(event.position().toPoint())
            self._continue_stroke(scene_pos)
 
    def mouseReleaseEvent(self, event):
        if self.is_stylus_active:
            return
        if event.button() == Qt.MouseButton.LeftButton:
            self._end_stroke()


    # ─────────────────────────────────────────
    #  STROKE LOGIC
    #  Shared by both mouse and tablet events.
    # ─────────────────────────────────────────
    def _start_stroke(self, pos):
        """Pen touches down — create a fresh path."""
        self.current_path = QPainterPath()
        self.current_path.moveTo(pos)
        self.last_point = pos
 
        pen = self._build_pen()
        self.current_path_item = self.scene.addPath(self.current_path, pen)
 
    def _continue_stroke(self, pos):
        """Pen is moving — extend the path to the new position."""
        if self.current_path is None:
            return
        self.current_path.lineTo(pos)
        self.last_point = pos
 
        # Update both the path shape and pen (pressure may have changed)
        self.current_path_item.setPath(self.current_path)
        self.current_path_item.setPen(self._build_pen())
 
    def _end_stroke(self):
        """Pen lifts — clean up ready for the next stroke."""
        self.current_path      = None
        self.current_path_item = None
        self.last_point        = None
 
    def _build_pen(self):
        """Constructs a QPen using current color, width, and pressure."""
        pen = QPen(self.pen_color)
        pen.setWidthF(self.stylus_pressure * self.pen_size)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        return pen
 
 
    # ─────────────────────────────────────────
    #  TOOL SETTERS
    #  Called from Main_window when toolbar
    #  buttons are clicked.
    # ─────────────────────────────────────────
    def set_pen_color(self, color: QColor):
        self.pen_color = color
 
    def set_pen_width(self, width: float):
        self.pen_size = width
 
    def set_tool(self, tool: str):
        self.current_tool = tool
 