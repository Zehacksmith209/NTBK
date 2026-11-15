import json
import os
import queue
import random
import secrets
import socket
import threading
import time

import bottle
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

# ─────────────────────────────────────────────
#  COMPANION MODE
#
#  Serves the real frontend to another device on
#  the LAN, and relays commands between it and
#  the laptop.
#
#  Python is a RELAY, not the authority. It has
#  no model of strokes, objects or layers and is
#  not gaining one: the live document lives in
#  the frontend store, and save_ntbk() has always
#  treated it as an opaque string. Teaching
#  Python the schema would mean a second
#  implementation of the data model, in a second
#  language, kept in lockstep forever.
#
#  So the laptop's own window stays the
#  authority. It pushes a snapshot here for new
#  clients to pull, and every command passes
#  through untouched.
#
#  bottle is already a pywebview dependency, so
#  this adds nothing to requirements.txt.
#
#  Plain HTTP, deliberately. A self-signed
#  certificate makes Safari show a full-page
#  security warning, and a student who sees that
#  concludes the app is broken. On a LAN, behind
#  a pairing code, with the server off by
#  default, that is the right trade.
# ─────────────────────────────────────────────

PORT = 8770


class _ThreadedWSGIServer(ThreadingMixIn, WSGIServer):
    """One thread per connection.

    bottle's default WSGIRefServer handles one request at a time, which is
    fatal here: an SSE stream is a request that never ends, so the first
    connected device would hold the only worker and every subsequent call —
    including its own command POSTs — would hang forever. That is the normal
    state of this server, not an edge case.
    """
    daemon_threads = True
    allow_reuse_address = True


class _QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass                    # one line per request is noise in the app log


class _ThreadedServer(bottle.ServerAdapter):
    def run(self, app):
        self.srv = make_server(self.host, self.port, app,
                               server_class=_ThreadedWSGIServer,
                               handler_class=_QuietHandler)
        self.srv.serve_forever()


class Companion:
    def __init__(self, dist_dir, on_command=None):
        self.dist = dist_dir
        self.on_command = on_command      # called with a command dict from a client
        self.code = None
        self.tokens = set()
        self.document = None              # opaque JSON string, pushed by the laptop
        self.clients = []                 # one queue per connected SSE listener
        self.lock = threading.Lock()
        self.server = None
        self.thread = None
        self.seen = set()                 # command uuids already relayed
        self.allow_code_execution = False # explicit, never implied by pairing

    # ── lifecycle ────────────────────────────
    def start(self):
        if self.thread:
            return self.info()
        self.code = f"{random.randint(0, 999999):06d}"
        app = self._build_app()
        self.server = _ThreadedServer(host="0.0.0.0", port=PORT)
        self.thread = threading.Thread(
            target=lambda: bottle.run(app=app, server=self.server, quiet=True),
            daemon=True)
        self.thread.start()
        time.sleep(0.3)
        return self.info()

    def stop(self):
        try:
            if self.server and getattr(self.server, "srv", None):
                self.server.srv.shutdown()
        except Exception:
            pass
        with self.lock:
            for q in self.clients:
                q.put(None)
            self.clients.clear()
        self.thread = None
        self.server = None
        self.code = None
        self.tokens.clear()

    @property
    def running(self):
        return self.thread is not None

    def info(self):
        return {"running": self.running, "url": f"http://{lan_ip()}:{PORT}/",
                "code": self.code, "clients": len(self.clients),
                "allowCode": self.allow_code_execution}

    # ── what the laptop pushes in ────────────
    def set_document(self, document_json):
        self.document = document_json

    def broadcast(self, message):
        """Fan a message out to every connected client."""
        data = json.dumps(message)
        with self.lock:
            dead = []
            for q in self.clients:
                try:
                    q.put_nowait(data)
                except Exception:
                    dead.append(q)
            for q in dead:
                self.clients.remove(q)

    # ── routes ───────────────────────────────
    def _authorised(self):
        token = bottle.request.get_header("X-ntbk-token") \
            or bottle.request.query.get("token")
        return token in self.tokens

    def _build_app(self):
        app = bottle.Bottle()

        @app.hook("after_request")
        def _headers():
            # Same-origin in practice, but Safari is fussy about SSE
            bottle.response.set_header("Access-Control-Allow-Origin", "*")
            bottle.response.set_header("Access-Control-Allow-Headers", "X-ntbk-token, Content-Type")

        @app.route("/pair", method=["POST", "OPTIONS"])
        def pair():
            if bottle.request.method == "OPTIONS":
                return {}
            body = bottle.request.json or {}
            if str(body.get("code", "")).strip() != self.code:
                bottle.response.status = 403
                return {"ok": False, "error": "Wrong code"}
            token = secrets.token_urlsafe(24)
            self.tokens.add(token)
            return {"ok": True, "token": token}

        @app.route("/document")
        def document():
            if not self._authorised():
                bottle.response.status = 401
                return {"ok": False, "error": "Not paired"}
            bottle.response.content_type = "application/json"
            return self.document or "{}"

        @app.route("/events")
        def events():
            if not self._authorised():
                bottle.response.status = 401
                return {"ok": False}
            bottle.response.content_type = "text/event-stream"
            bottle.response.set_header("Cache-Control", "no-cache")
            bottle.response.set_header("X-Accel-Buffering", "no")
            q = queue.Queue()
            with self.lock:
                self.clients.append(q)

            def stream():
                yield "retry: 2000\n\n"
                try:
                    while True:
                        try:
                            item = q.get(timeout=15)
                        except queue.Empty:
                            yield ": ping\n\n"       # keeps Safari from closing it
                            continue
                        if item is None:
                            break
                        yield f"data: {item}\n\n"
                finally:
                    with self.lock:
                        if q in self.clients:
                            self.clients.remove(q)
            return stream()

        @app.route("/commands", method=["POST", "OPTIONS"])
        def commands():
            if bottle.request.method == "OPTIONS":
                return {}
            if not self._authorised():
                bottle.response.status = 401
                return {"ok": False}
            body = bottle.request.json or {}
            batch = body.get("commands") or []
            applied = []
            for command in batch:
                cid = command.get("id")
                # Deduped by id rather than by trying to work out whether a
                # send arrived. Double delivery is made harmless instead.
                if not cid or cid in self.seen:
                    continue
                self.seen.add(cid)
                applied.append(cid)
                if self.on_command:
                    self.on_command(command)
            return {"ok": True, "applied": applied}

        @app.route("/")
        @app.route("/<path:path>")
        def static(path="index.html"):
            # The pairing page is the only thing servable before a token,
            # because the frontend itself has to load in order to ask.
            return bottle.static_file(path, root=self.dist)

        return app


def lan_ip():
    """This machine's address on the LAN, without touching the internet."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Never actually sends; just asks the routing table which interface
        # would be used, which is the one the iPad can reach.
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()
