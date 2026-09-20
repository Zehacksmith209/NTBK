import os
import sys

import webview

from bridge import Api


# ─────────────────────────────────────────────
#  SHELL
#
#  A native window wrapping the system webview.
#  No Electron, no local HTTP server, no browser
#  tab — the built frontend is loaded off disk.
# ─────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "..", "frontend", "dist", "index.html")
DEV_URL = "http://localhost:5273"


def resolve_entry():
    """Use the Vite dev server when asked, otherwise the built bundle."""
    if "--dev" in sys.argv:
        return DEV_URL

    dist = os.path.normpath(DIST)
    if not os.path.exists(dist):
        raise SystemExit(
            "frontend/dist not found.\n"
            "Build it first:  cd frontend && npm run build\n"
            "Or run against the dev server:  npm run dev, then python ntbk/app.py --dev"
        )
    return dist


WINDOW = {
    "width": 1440,
    "height": 940,
    "min_size": (900, 600),
    "background_color": "#f2f3f5",
}


def document_argument():
    """A .ntbk handed to us on the command line, if any.

    Also the groundwork for double-clicking a notebook: once there is a .app
    bundle declaring the extension, macOS passes the file exactly this way.
    """
    for arg in sys.argv[1:]:
        if arg.lower().endswith(".ntbk") and os.path.exists(arg):
            return os.path.abspath(arg)
    return None


def open_window():
    """One window, one Api, one document.

    Keeping the Api per window is what makes several notebooks open at once
    behave: each carries its own current file, its own terminals and its own
    working directory, so they cannot tread on each other.
    """
    api = Api()
    api.pending_open = document_argument()
    window = webview.create_window("ntbk", resolve_entry(), js_api=api, **WINDOW)
    api.attach(window, open_window)
    return window


def main():
    open_window()
    webview.start(debug="--debug" in sys.argv)


if __name__ == "__main__":
    main()
