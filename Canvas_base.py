import sys
import math
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QToolBar, QWidget,
    QVBoxLayout, QGraphicsScene, QGraphicsView, QLabel,
    QSizePolicy, QToolButton, QMenu, QWidgetAction, QComboBox, QSpinBox,
    QGraphicsItem, QColorDialog, QInputDialog, QGraphicsPathItem,
    QGraphicsProxyWidget
)
from PyQt6.QtGui import (
    QAction, QIcon, QColor, QPainter, QCursor, QPainterPath, QPen, QBrush,
    QTransform
)
from PyQt6.QtCore import Qt, QSize, QPointF, QRectF

from Latex_box import LatexItem, LatexEditor







# ─────────────────────────────────────────────
#  CANVAS
#  This is the main drawing area — built on
#  QGraphicsScene/QGraphicsView which will
#  later handle drawing, shapes, images etc.
# ─────────────────────────────────────────────


class Canvas(QGraphicsView):

    # ── Stacking order ──────────────────────────────────
    #  Everything on the canvas layers in this order, bottom to top.
    #  Inserted objects (LaTeX boxes, and later images and tables) go at
    #  the bottom so pen and highlighter always draw on top of them —
    #  otherwise an object behaves like a floating panel you can't write on.
    Z_OBJECT    = -10   # LaTeX boxes, images, tables
    Z_HIGHLIGHT = -1    # highlighter, under the ink but over objects
    Z_INK       = 0     # pen strokes
    Z_SELECTION = 1000  # selection box
    Z_ERASER    = 1001  # eraser ring
    Z_HANDLE    = 1002  # resize handles

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

        #----Highlighter-----
        #Semi-transparent so whatever is underneath still reads through it.
        #Alpha is held fixed and the colour picker only changes the hue —
        #picking your own alpha per colour makes it easy to end up with
        #a "highlighter" that's actually opaque.
        self.highlight_alpha = 100
        self.highlight_color = QColor(255, 235, 0, self.highlight_alpha)
        self.highlight_size  = 20.0

        #----Stroke Tracking-----
        #These three variables track the stroke currently being drawn
        #They reset to None after every stroke is completed
        self.current_path = None # QPainterPath being built point by point
        self.current_path_item = None # live item sitting on the scene/canvas
        
        self.last_point = None     # Last mouse position, for smooth lines


        self.stylus_pressure  = 1.0     # 0.0 → 1.0, defaults to full
        self.is_stylus_active = False   # flips True when tablet events arrive

        #----Lasso Tracking-----
        #Mirrors the stroke variables above, but the path being built is the
        #selection loop rather than ink. None means "no lasso in progress".
        self.lasso_path      = None
        self.lasso_path_item = None

        #----Selection Box-----
        #Dashed rectangle drawn around whatever is currently selected.
        #Grabbing anywhere inside it drags the whole selection.
        self.selection_box    = None
        self.moving_selection = False
        self.move_last_point  = None
        self.scene.selectionChanged.connect(self._refresh_selection_box)

        #----Resize Handles-----
        #Eight small squares on the selection box: four corners, four edges.
        #Order is fixed and indexed by HANDLE_* below.
        self.handles          = []
        self.handle_size      = 8.0
        self.resize_handle    = None   # index of the handle being dragged
        self.resize_orig_rect = None   # box rect when the drag started
        self.resize_items     = []     # ink:     (item, original points, original width)
        self.resize_objects   = []     # objects: (item, original pos, original size)

        # True while a click is being passed through to an embedded widget,
        # so the drag and release go to it as well
        self.widget_interaction = False

        # The floating LaTeX source editor, when one is open
        self.latex_editor = None

        #----Eraser-----
        #One fixed size for now; adjustable sizes come later.
        self.eraser_radius = 12.0
        self.eraser_cursor = None   # ring drawn on the canvas so you can aim

        # Needed so the eraser ring follows the pointer, and so the selection
        # box can show a grab cursor, without a button being held down
        self.setMouseTracking(True)

        # Rubber band (rectangle select) only picks items fully covered,
        # matching the lasso rule so both tools behave the same way.
        self.setRubberBandSelectionMode(Qt.ItemSelectionMode.ContainsItemShape)

        # Needed so the canvas receives Delete/Escape key presses
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)


    # ─────────────────────────────────────────
    #  TABLET (STYLUS) EVENTS
    #  Fires for Wacom or Apple Pencil via Sidecar.
    #  Gives pressure + tilt — mouse events don't have these.
    # ─────────────────────────────────────────
    def tabletEvent(self, event):
        # The select tools are easier to drive through the normal mouse path,
        # so ignore the tablet event and let Qt synthesise mouse events instead.
        if self.current_tool in ("lasso", "select_rect"):
            self.is_stylus_active = False
            event.ignore()
            return

        scene_pos = self.mapToScene(event.position().toPoint())

        # Erasing has no stroke to build, so it short-circuits the pen logic
        if self.current_tool in ("eraser_stroke", "eraser_partial"):
            self._move_eraser_cursor(scene_pos)
            if event.type() in (event.Type.TabletPress, event.Type.TabletMove):
                self.is_stylus_active = True
                if event.pressure() > 0:
                    self._erase_at(scene_pos)
            elif event.type() == event.Type.TabletRelease:
                self.is_stylus_active = False
            event.accept()
            return

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
        if event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return

        scene_pos = self.mapToScene(event.position().toPoint())

        if self.current_tool in ("eraser_stroke", "eraser_partial"):
            self._erase_at(scene_pos)
            return

        if self.current_tool in ("lasso", "select_rect"):
            # Handles sit on the edge of the box, so they get first refusal
            handle = self._handle_at(scene_pos)
            if handle is not None:
                self._start_resize(handle)
                return

            # Pressing anywhere inside the selection box drags the whole
            # selection — including the empty gaps between strokes.
            if self._point_in_selection(scene_pos):
                self.moving_selection = True
                self.move_last_point  = scene_pos
                self.setCursor(Qt.CursorShape.ClosedHandCursor)
                return

            # Pressing on an embedded box that isn't part of the selection
            # means "use the box" — click into it and type. Move it by
            # selecting it first and dragging from inside the selection.
            if isinstance(self.scene.itemAt(scene_pos, self.transform()),
                          QGraphicsProxyWidget):
                self.widget_interaction = True
                super().mousePressEvent(event)
                return

            # Pressing outside it starts a fresh selection
            if self.current_tool == "select_rect":
                self.scene.clearSelection()
                super().mousePressEvent(event)   # Qt's rubber band takes over
            else:
                self._start_lasso(scene_pos)
            return

        # Pen (default)
        self._start_stroke(scene_pos)

    def mouseMoveEvent(self, event):
        if self.is_stylus_active:
            return

        if self.current_tool in ("eraser_stroke", "eraser_partial"):
            scene_pos = self.mapToScene(event.position().toPoint())
            self._move_eraser_cursor(scene_pos)
            if event.buttons() & Qt.MouseButton.LeftButton:
                self._erase_at(scene_pos)
            return

        if self.current_tool in ("lasso", "select_rect"):
            scene_pos = self.mapToScene(event.position().toPoint())

            if self.widget_interaction:
                super().mouseMoveEvent(event)   # dragging inside a LaTeX box
            elif self.resize_handle is not None:
                self._resize_selection(scene_pos)
            elif self.moving_selection:
                self._move_selection(scene_pos)
            elif self.lasso_path is not None:
                self._continue_lasso(scene_pos)
            else:
                self._update_hover_cursor(scene_pos)
                if self.current_tool == "select_rect":
                    super().mouseMoveEvent(event)
            return

        if event.buttons() & Qt.MouseButton.LeftButton:
            scene_pos = self.mapToScene(event.position().toPoint())
            self._continue_stroke(scene_pos)

    def mouseReleaseEvent(self, event):
        if self.is_stylus_active:
            return

        if self.current_tool in ("eraser_stroke", "eraser_partial"):
            return

        if self.current_tool in ("lasso", "select_rect"):
            if self.widget_interaction:
                self.widget_interaction = False
                super().mouseReleaseEvent(event)
            elif self.resize_handle is not None:
                self.resize_handle    = None
                self.resize_orig_rect = None
                self.resize_items     = []
                self.resize_objects   = []
            elif self.moving_selection:
                self.moving_selection = False
                self.move_last_point  = None
                self.setCursor(Qt.CursorShape.OpenHandCursor)
            elif self.lasso_path is not None:
                self._end_lasso()
            elif self.current_tool == "select_rect":
                super().mouseReleaseEvent(event)
            return

        if event.button() == Qt.MouseButton.LeftButton:
            self._end_stroke()

    # ─────────────────────────────────────────
    #  KEYBOARD
    # ─────────────────────────────────────────
    def keyPressEvent(self, event):
        # If you're typing in a LaTeX box, the keys belong to it — otherwise
        # Backspace would delete the box instead of a character
        if self.scene.focusItem() is not None:
            super().keyPressEvent(event)
            return

        if event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            self.delete_selection()
        elif event.key() == Qt.Key.Key_Escape:
            self.scene.clearSelection()
        else:
            super().keyPressEvent(event)


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

        # Highlighter sits underneath the ink, so writing stays readable
        # when you go over it — same as OneNote.
        if self.current_tool == "highlighter":
            self.current_path_item.setZValue(self.Z_HIGHLIGHT)
 
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
        """Pen lifts — finalise the stroke and clean up for the next one."""
        if self.current_path_item is not None:
            # Only now does the stroke become a thing the select tools can pick up.
            # Moving is handled by the selection box, not ItemIsMovable, so that
            # dragging works from the gaps between strokes too.
            self.current_path_item.setFlag(
                QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)

        self.current_path      = None
        self.current_path_item = None
        self.last_point        = None

    def _build_pen(self):
        """Constructs a QPen using current color, width, and pressure."""
        if self.current_tool == "highlighter":
            pen = QPen(self.highlight_color)
            pen.setWidthF(self.highlight_size)   # a marker doesn't taper
            pen.setCapStyle(Qt.PenCapStyle.FlatCap)
            pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
            return pen

        pen = QPen(self.pen_color)
        pen.setWidthF(self.stylus_pressure * self.pen_size)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        return pen
 
 
    # ─────────────────────────────────────────
    #  LASSO SELECTION
    #  Built exactly like a stroke, except the
    #  path is a selection loop, not ink.
    # ─────────────────────────────────────────
    def _start_lasso(self, pos):
        """Lasso starts — anything previously picked is dropped."""
        self.scene.clearSelection()

        self.lasso_path = QPainterPath()
        self.lasso_path.moveTo(pos)

        pen = QPen(QColor("#1a6ef5"))
        pen.setStyle(Qt.PenStyle.DashLine)
        pen.setWidthF(1.0)
        self.lasso_path_item = self.scene.addPath(self.lasso_path, pen)

    def _continue_lasso(self, pos):
        """Extend the loop as the pointer moves."""
        if self.lasso_path is None:
            return
        self.lasso_path.lineTo(pos)
        self.lasso_path_item.setPath(self.lasso_path)

    def _end_lasso(self):
        """Close the loop, select what's inside it, throw the loop away."""
        if self.lasso_path is None:
            return

        self.lasso_path.closeSubpath()

        # Remove the dashed outline first, otherwise it shows up in its own hit test
        self.scene.removeItem(self.lasso_path_item)

        # ContainsItemShape = the stroke must sit *entirely* inside the loop
        for item in self.scene.items(self.lasso_path,
                                     Qt.ItemSelectionMode.ContainsItemShape):
            if item.flags() & QGraphicsItem.GraphicsItemFlag.ItemIsSelectable:
                item.setSelected(True)

        self.lasso_path      = None
        self.lasso_path_item = None

    # ─────────────────────────────────────────
    #  ERASER
    #  Two modes: "eraser_stroke" removes whole
    #  strokes, "eraser_partial" cuts away only
    #  the bit under the eraser circle.
    # ─────────────────────────────────────────
    def _erase_at(self, pos):
        """Erase whatever the eraser circle is currently covering."""
        circle = QPainterPath()
        circle.addEllipse(pos, self.eraser_radius, self.eraser_radius)

        # Only ink is erasable. The selection box and eraser ring are excluded
        # by the selectable check; LaTeX boxes and images are excluded by the
        # path check, so you can't destroy one by swiping across it — delete
        # those with the selection tools instead.
        targets = [i for i in self.scene.items(circle,
                                               Qt.ItemSelectionMode.IntersectsItemShape)
                   if i.flags() & QGraphicsItem.GraphicsItemFlag.ItemIsSelectable
                   and isinstance(i, QGraphicsPathItem)]

        for item in targets:
            if self.current_tool == "eraser_stroke":
                self.scene.removeItem(item)
            else:
                self._erase_part_of(item, pos)

    def _erase_part_of(self, item, center):
        """Cut a hole in one stroke, leaving the surviving pieces behind.

        The stroke is kept as a line path rather than converted to a filled
        outline, so its colour and thickness stay editable afterwards.
        """
        path = item.path()

        # Read the stroke back out as points, in scene coordinates so a stroke
        # that has been dragged around still lines up with the eraser
        points = [item.mapToScene(QPointF(path.elementAt(i).x, path.elementAt(i).y))
                  for i in range(path.elementCount())]
        if len(points) < 2:
            return

        # A fast swipe leaves long straight segments with no point in the
        # middle, so add points along them before testing — otherwise the
        # eraser would pass straight through without cutting anything
        points = self._densify(points, self.eraser_radius / 2.0)

        # Split into runs of points the eraser did not touch
        runs, current = [], []
        erased_any = False
        for p in points:
            dx, dy = p.x() - center.x(), p.y() - center.y()
            if (dx * dx + dy * dy) <= self.eraser_radius ** 2:
                erased_any = True
                if len(current) >= 2:
                    runs.append(current)
                current = []
            else:
                current.append(p)
        if len(current) >= 2:
            runs.append(current)

        if not erased_any:
            return

        pen = item.pen()
        z   = item.zValue()   # a cut highlighter must stay behind the ink
        self.scene.removeItem(item)

        for run in runs:
            new_path = QPainterPath()
            new_path.moveTo(run[0])
            for p in run[1:]:
                new_path.lineTo(p)
            piece = self.scene.addPath(new_path, pen)
            piece.setZValue(z)
            piece.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)

    def _densify(self, points, max_len):
        """Insert extra points so no segment is longer than max_len.

        Purely a resolution fix — the points sit on the existing lines, so the
        stroke looks identical.
        """
        out = [points[0]]
        for a, b in zip(points, points[1:]):
            dist = math.hypot(b.x() - a.x(), b.y() - a.y())
            steps = int(dist / max_len)
            for s in range(1, steps):
                t = s / steps
                out.append(QPointF(a.x() + (b.x() - a.x()) * t,
                                   a.y() + (b.y() - a.y()) * t))
            out.append(b)
        return out

    def _move_eraser_cursor(self, pos):
        """Keep the eraser ring under the pointer so you can see what it covers."""
        if self.eraser_cursor is None:
            pen = QPen(QColor("#888888"))
            pen.setWidthF(1.0)
            self.eraser_cursor = self.scene.addEllipse(
                -self.eraser_radius, -self.eraser_radius,
                self.eraser_radius * 2, self.eraser_radius * 2, pen)
            self.eraser_cursor.setZValue(self.Z_ERASER)
        self.eraser_cursor.setPos(pos)

    def _clear_eraser_cursor(self):
        if self.eraser_cursor is not None:
            self.scene.removeItem(self.eraser_cursor)
            self.eraser_cursor = None

    # ─────────────────────────────────────────
    #  SELECTION BOX
    #  The dashed rectangle around the current
    #  selection, and the drag handling for it.
    # ─────────────────────────────────────────
    def _refresh_selection_box(self):
        """Redraw the box to fit whatever is selected — called by Qt on every
        selection change, so it stays in sync on its own."""
        self._clear_handles()
        if self.selection_box is not None:
            self.scene.removeItem(self.selection_box)
            self.selection_box = None

        items = self.scene.selectedItems()
        if not items:
            return

        rect = items[0].sceneBoundingRect()
        for item in items[1:]:
            rect = rect.united(item.sceneBoundingRect())
        rect = rect.adjusted(-6, -6, 6, 6)   # breathing room, easier to grab

        pen = QPen(QColor("#1a6ef5"))
        pen.setStyle(Qt.PenStyle.DashLine)
        pen.setWidthF(1.0)
        self.selection_box = self.scene.addRect(rect, pen)
        self.selection_box.setZValue(self.Z_SELECTION)
        self._rebuild_handles()

    # ── Resize handles ──────────────────────────────────
    #  Index order, used by _resize_selection to work out
    #  which edges a given handle moves:
    #    0 1 2
    #    7   3
    #    6 5 4
    def _handle_points(self, rect):
        cx = rect.center().x()
        cy = rect.center().y()
        return [
            QPointF(rect.left(),  rect.top()),     # 0 top-left
            QPointF(cx,           rect.top()),     # 1 top
            QPointF(rect.right(), rect.top()),     # 2 top-right
            QPointF(rect.right(), cy),             # 3 right
            QPointF(rect.right(), rect.bottom()),  # 4 bottom-right
            QPointF(cx,           rect.bottom()),  # 5 bottom
            QPointF(rect.left(),  rect.bottom()),  # 6 bottom-left
            QPointF(rect.left(),  cy),             # 7 left
        ]

    def _rebuild_handles(self):
        self._clear_handles()
        if self.selection_box is None:
            return

        h = self.handle_size / 2.0
        pen = QPen(QColor("#1a6ef5"))
        pen.setWidthF(1.0)

        for p in self._handle_points(self.selection_box.sceneBoundingRect()):
            box = self.scene.addRect(-h, -h, self.handle_size, self.handle_size,
                                     pen, QBrush(QColor("#ffffff")))
            box.setPos(p)
            box.setZValue(self.Z_HANDLE)
            self.handles.append(box)

    def _clear_handles(self):
        for box in self.handles:
            self.scene.removeItem(box)
        self.handles = []

    def _handle_at(self, pos):
        """Which handle (if any) is under pos. Grab area is deliberately
        larger than the drawn square so it's easy to hit with a stylus."""
        if self.selection_box is None:
            return None
        grab = self.handle_size   # full size as the half-width = double the target
        for i, p in enumerate(self._handle_points(self.selection_box.sceneBoundingRect())):
            if abs(pos.x() - p.x()) <= grab and abs(pos.y() - p.y()) <= grab:
                return i
        return None

    def _start_resize(self, handle):
        """Snapshot the geometry so every drag step scales from the original.

        Rescaling from the *current* shape each time would let rounding errors
        pile up over a long drag and slowly distort the strokes.
        """
        self.resize_handle    = handle
        self.resize_orig_rect = self.selection_box.sceneBoundingRect()
        self.resize_items     = []
        self.resize_objects   = []

        for item in self.scene.selectedItems():
            if isinstance(item, QGraphicsPathItem):
                # Ink is rebuilt point by point so it stays a real path
                path = item.path()
                points = [item.mapToScene(QPointF(path.elementAt(i).x,
                                                  path.elementAt(i).y))
                          for i in range(path.elementCount())]
                self.resize_items.append((item, points, item.pen().widthF()))
            else:
                # Boxes and images have no path — they get repositioned and
                # given a new size instead
                self.resize_objects.append(
                    (item, item.pos(), item.boundingRect().size()))

    def _resize_selection(self, pos):
        """Drag a handle — stretch the original geometry into the new box."""
        if self.resize_orig_rect is None:
            return

        orig = self.resize_orig_rect
        left, top     = orig.left(),  orig.top()
        right, bottom = orig.right(), orig.bottom()

        # Handles 0,7,6 pull the left edge; 2,3,4 pull the right; and so on
        if self.resize_handle in (0, 6, 7):
            left = pos.x()
        if self.resize_handle in (2, 3, 4):
            right = pos.x()
        if self.resize_handle in (0, 1, 2):
            top = pos.y()
        if self.resize_handle in (4, 5, 6):
            bottom = pos.y()

        # Stop the box collapsing or turning inside out
        MIN = 12.0
        if right - left < MIN:
            if self.resize_handle in (0, 6, 7):
                left = right - MIN
            else:
                right = left + MIN
        if bottom - top < MIN:
            if self.resize_handle in (0, 1, 2):
                top = bottom - MIN
            else:
                bottom = top + MIN

        sx = (right - left) / orig.width()
        sy = (bottom - top) / orig.height()
        # Thickness follows the overall scale, so shrunk ink doesn't look blobby
        scale_pen = math.sqrt(abs(sx * sy))

        for item, points, orig_width in self.resize_items:
            new_path = QPainterPath()
            for i, p in enumerate(points):
                mapped = QPointF(left + (p.x() - orig.left()) * sx,
                                 top  + (p.y() - orig.top())  * sy)
                if i == 0:
                    new_path.moveTo(mapped)
                else:
                    new_path.lineTo(mapped)

            item.setPos(0, 0)   # geometry is rebuilt in scene coords
            item.setPath(new_path)

            pen = item.pen()
            pen.setWidthF(max(0.5, orig_width * scale_pen))
            item.setPen(pen)

        for item, orig_pos, orig_size in self.resize_objects:
            item.setPos(left + (orig_pos.x() - orig.left()) * sx,
                        top  + (orig_pos.y() - orig.top())  * sy)
            new_w = max(40.0, orig_size.width()  * sx)
            new_h = max(40.0, orig_size.height() * sy)
            if isinstance(item, QGraphicsProxyWidget):
                # Resizing the widget itself keeps its text crisp, where
                # scaling it with a transform would just magnify pixels
                item.resize(new_w, new_h)
            else:
                item.setTransform(QTransform().scale(
                    new_w / orig_size.width(), new_h / orig_size.height()))

        self.selection_box.setPos(0, 0)
        self.selection_box.setRect(QRectF(left, top, right - left, bottom - top))
        self._rebuild_handles()

    # ─────────────────────────────────────────
    #  SELECTION PROPERTIES
    # ─────────────────────────────────────────
    def _selected_ink(self):
        """Only strokes have a pen, so colour and thickness skip everything else."""
        return [i for i in self.scene.selectedItems()
                if isinstance(i, QGraphicsPathItem)]

    def set_selection_color(self, color: QColor):
        for item in self._selected_ink():
            pen = item.pen()
            pen.setColor(color)
            item.setPen(pen)

    def set_selection_width(self, width: float):
        for item in self._selected_ink():
            pen = item.pen()
            pen.setWidthF(width)
            item.setPen(pen)
        self._refresh_selection_box()   # thicker ink means a bigger bounding box

    def has_selection(self):
        return bool(self.scene.selectedItems())

    def _update_hover_cursor(self, pos):
        """Show what a press would do: resize, grab, or start a new selection."""
        handle = self._handle_at(pos)
        if handle is not None:
            self.setCursor([
                Qt.CursorShape.SizeFDiagCursor,  # 0 top-left
                Qt.CursorShape.SizeVerCursor,    # 1 top
                Qt.CursorShape.SizeBDiagCursor,  # 2 top-right
                Qt.CursorShape.SizeHorCursor,    # 3 right
                Qt.CursorShape.SizeFDiagCursor,  # 4 bottom-right
                Qt.CursorShape.SizeVerCursor,    # 5 bottom
                Qt.CursorShape.SizeBDiagCursor,  # 6 bottom-left
                Qt.CursorShape.SizeHorCursor,    # 7 left
            ][handle])
        elif self._point_in_selection(pos):
            self.setCursor(Qt.CursorShape.OpenHandCursor)
        else:
            self.setCursor(Qt.CursorShape.CrossCursor)

    def _point_in_selection(self, pos):
        """True if pos is inside the selection box — the grab area for moving."""
        if self.selection_box is None:
            return False
        # sceneBoundingRect rather than rect(), so it stays correct after a move
        return self.selection_box.sceneBoundingRect().contains(pos)

    def _move_selection(self, pos):
        """Shift every selected item by however far the pointer travelled."""
        if self.move_last_point is None:
            return
        delta = pos - self.move_last_point
        self.move_last_point = pos

        for item in self.scene.selectedItems():
            item.moveBy(delta.x(), delta.y())

        # The box and its handles have to follow the ink they're wrapped around
        if self.selection_box is not None:
            self.selection_box.moveBy(delta.x(), delta.y())
        for box in self.handles:
            box.moveBy(delta.x(), delta.y())

    # ─────────────────────────────────────────
    #  RIGHT-CLICK MENU
    # ─────────────────────────────────────────
    def contextMenuEvent(self, event):
        scene_pos = self.mapToScene(event.pos())
        if not self._point_in_selection(scene_pos):
            return

        menu = QMenu(self)
        menu.addAction("Change Color").triggered.connect(self._ask_selection_color)
        menu.addAction("Change Thickness").triggered.connect(self._ask_selection_width)
        menu.addSeparator()
        menu.addAction("Delete").triggered.connect(self.delete_selection)
        menu.exec(event.globalPos())

    def _ask_selection_color(self):
        color = QColorDialog.getColor(self.pen_color, self, "Selection Color")
        if color.isValid():
            self.set_selection_color(color)

    def _ask_selection_width(self):
        width, ok = QInputDialog.getDouble(
            self, "Selection Thickness", "Thickness:", self.pen_size, 0.5, 50.0, 1)
        if ok:
            self.set_selection_width(width)

    # ─────────────────────────────────────────
    #  SELECTION ACTIONS
    # ─────────────────────────────────────────
    def delete_selection(self):
        for item in self.scene.selectedItems():
            self.scene.removeItem(item)
        self._refresh_selection_box()

    # ─────────────────────────────────────────
    #  TOOL SETTERS
    #  Called from Main_window when toolbar
    #  buttons are clicked.
    # ─────────────────────────────────────────
    def set_pen_color(self, color: QColor):
        self.pen_color = color

    def set_pen_width(self, width: float):
        self.pen_size = width

    def set_highlight_color(self, color: QColor):
        """Takes the hue only — transparency is fixed, see highlight_alpha."""
        self.highlight_color = QColor(color.red(), color.green(), color.blue(),
                                      self.highlight_alpha)

    def set_highlight_width(self, width: float):
        self.highlight_size = width

    def add_latex(self, pos=None, source=None):
        """Put a new formula on the canvas and open its source editor.

        What lands on the canvas is the typeset output alone — no panel and no
        white backing — so formulas sit on the page like writing and don't
        block out whatever they overlap.
        """
        if pos is None:
            pos = self.mapToScene(self.viewport().rect().center())

        item = LatexItem(source)
        item.setPos(pos)
        item.setZValue(self.Z_OBJECT)
        self.scene.addItem(item)

        self.open_latex_editor(item)
        self.latex_editor.render_now()   # show the default formula straight away
        return item

    def open_latex_editor(self, item):
        """Only one editor at a time, parked next to the formula it edits."""
        if self.latex_editor is not None:
            self.latex_editor.close_editor()

        self.latex_editor = LatexEditor(self, item)
        self.latex_editor.place_near_item()
        self.latex_editor.show()
        return self.latex_editor

    def latex_item_at(self, pos):
        for item in self.scene.items(pos):
            if isinstance(item, LatexItem):
                return item
        return None

    def mouseDoubleClickEvent(self, event):
        # Double-click rather than single, so clicking to select and drag a
        # formula doesn't pop the editor open every time
        if self.current_tool in ("lasso", "select_rect"):
            item = self.latex_item_at(self.mapToScene(event.position().toPoint()))
            if item is not None:
                self.open_latex_editor(item)
                return
        super().mouseDoubleClickEvent(event)

    def set_tool(self, tool: str):
        self.current_tool = tool

        # Leaving the select tools drops keyboard focus, so typing doesn't
        # keep going into a LaTeX box after you've switched to the pen
        if tool not in ("lasso", "select_rect"):
            self.widget_interaction = False
            if self.scene.focusItem() is not None:
                self.scene.focusItem().clearFocus()

        # Rubber band is Qt's own drag mode, so it has to be switched on and
        # off with the tool — leaving it on would block drawing.
        if tool == "select_rect":
            self.setDragMode(QGraphicsView.DragMode.RubberBandDrag)
        else:
            self.setDragMode(QGraphicsView.DragMode.NoDrag)

        if tool not in ("eraser_stroke", "eraser_partial"):
            self._clear_eraser_cursor()

        if tool in ("lasso", "select_rect"):
            self.setCursor(Qt.CursorShape.CrossCursor)
        else:
            # Leaving a tool drops whatever was picked, so the next pen stroke
            # doesn't accidentally drag an old selection around
            self.scene.clearSelection()
            # The eraser has its own ring, so hide the pointer over the canvas
            self.setCursor(Qt.CursorShape.BlankCursor
                           if tool in ("eraser_stroke", "eraser_partial")
                           else Qt.CursorShape.ArrowCursor)
