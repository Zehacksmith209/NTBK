import base64
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time
import uuid

# ─────────────────────────────────────────────
#  TERMINAL SESSIONS
#
#  A real pseudo-terminal per code cell, running
#  the user's own shell in the notebook's working
#  directory.
#
#  A pty rather than piped subprocesses because
#  that is what makes input() show its prompt and
#  wait, Ctrl+C interrupt, and ordinary shell
#  commands behave — none of which work when
#  stdout is a pipe.
# ─────────────────────────────────────────────
DONE_PREFIX = "__ntbk_done_"


class Session:
    def __init__(self, workdir, shell=None, cols=80, rows=24):
        self.workdir = workdir
        self.master, slave = pty.openpty()
        self._set_size(cols, rows)

        environment = dict(os.environ)
        environment["TERM"] = "xterm-256color"
        # Keeps zsh from redrawing a themed prompt over our output
        environment.setdefault("PS1", "$ ")

        def become_session_leader():
            # A new session, and then claim this pty as its CONTROLLING
            # terminal. Without the second step the session has no controlling
            # tty, so Ctrl+C is echoed as ^C but no SIGINT is ever delivered —
            # the program keeps waiting and swallows whatever you type next.
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(
            [shell or os.environ.get("SHELL", "/bin/zsh")],
            preexec_fn=become_session_leader,
            stdin=slave, stdout=slave, stderr=slave,
            cwd=workdir, env=environment, close_fds=True,
        )
        os.close(slave)

        flags = fcntl.fcntl(self.master, fcntl.F_GETFL)
        fcntl.fcntl(self.master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        self.pending_marker = None      # set while a Run is in flight
        self.snapshot = None            # folder contents when that Run started
        # Recent output, kept so an end-marker split across two reads is
        # still spotted
        self.tail = ""
        self.carry = ""            # partial marker held back from display
        self.marker_pattern = None  # compiled while a Run is in flight

    def _set_size(self, cols, rows):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ,
                    struct.pack("HHHH", rows, cols, 0, 0))

    def resize(self, cols, rows):
        self._set_size(cols, rows)

    def write(self, text):
        os.write(self.master, text.encode("utf-8", "replace"))

    def read(self, timeout=0.08):
        """Wait briefly for output, then return whatever arrived.

        Long-polling rather than a push: the bridge is request/response, and
        a short blocking read gives the same feel as streaming without
        needing to call into JS from a background thread.
        """
        chunks = []
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            ready, _, _ = select.select([self.master], [], [], remaining)
            if not ready:
                break
            try:
                data = os.read(self.master, 65536)
            except OSError as error:
                if error.errno in (errno.EIO, errno.EAGAIN):
                    break
                raise
            if not data:
                break
            chunks.append(data)
            # Keep draining anything already buffered before returning
            deadline = min(deadline, time.time() + 0.01)

        data = b"".join(chunks)
        if data:
            self.tail = (self.tail + data.decode("utf-8", "replace"))[-8192:]
        return data

    def alive(self):
        return self.process.poll() is None

    def close(self):
        try:
            os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
        except Exception:
            pass
        # Give it a moment to die, so alive() tells the truth afterwards
        for _ in range(20):
            if self.process.poll() is not None:
                break
            time.sleep(0.01)
        try:
            os.close(self.master)
        except Exception:
            pass


class TerminalManager:
    def __init__(self):
        self.sessions = {}

    def open(self, cell_id, workdir, cols=80, rows=24):
        session = self.sessions.get(cell_id)
        if session and session.alive():
            session.resize(cols, rows)
            return True
        if session:
            session.close()
        self.sessions[cell_id] = Session(workdir, cols=cols, rows=rows)
        return True

    def get(self, cell_id):
        return self.sessions.get(cell_id)

    def close(self, cell_id):
        session = self.sessions.pop(cell_id, None)
        if session:
            session.close()
        return True

    def close_all(self):
        for cell_id in list(self.sessions):
            self.close(cell_id)


def make_marker():
    return f"{DONE_PREFIX}{uuid.uuid4().hex[:8]}"


def _snapshot_dir(folder):
    """Folder contents, for spotting what a run produced."""
    from services.runner import _snapshot
    return _snapshot(folder)
