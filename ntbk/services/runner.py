import base64
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

# ─────────────────────────────────────────────
#  CODE RUNNER
#
#  Runs a cell's source and reports back what it
#  printed, what it exited with, and any files
#  it produced.
#
#  Never invoked on file open — only on an
#  explicit click in the UI. A .ntbk from a
#  classmate can contain anything, and this runs
#  with the user's own privileges.
# ─────────────────────────────────────────────
DEFAULT_TIMEOUT = 30

# Artefacts we know how to show as an extra tab
VIEWABLE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".html", ".htm"}
MAX_ARTEFACT_BYTES = 12 * 1024 * 1024

# Wrapped around Python cells so a figure left open by plt.show() becomes a
# tab, the way it would in a notebook. Nothing else is injected.
MATPLOTLIB_EPILOGUE = """
try:
    import matplotlib
    if "matplotlib.pyplot" in __import__("sys").modules:
        import matplotlib.pyplot as _plt
        for _i in _plt.get_fignums():
            _plt.figure(_i).savefig("figure-%d.png" % _i, dpi=140, bbox_inches="tight")
except Exception:
    pass
"""


class Language:
    """A language, and one or more ways to run it.

    Variants exist because several languages have more than one plausible
    runtime — MATLAB or Octave for .m, tsx or ts-node or deno for .ts. The
    first one actually present on the machine wins, so a user with the real
    thing gets the real thing and everyone else gets the free stand-in.
    """

    def __init__(self, name, variants, compile_cmd=None, run_cmd=None):
        # variants: [(probe binary, shell command), ...] in order of preference
        self.name = name
        self.variants = variants
        self.compile_cmd = compile_cmd
        self.run_cmd = run_cmd

    @property
    def probe(self):
        return self.variants[0][0]

    @property
    def command(self):
        return self.variants[0][1]

    def resolve(self, path):
        """The first variant this machine can run, or None."""
        for binary, command in self.variants:
            on_path = shutil.which(binary, path=path)
            found = on_path or _find_bundled(binary)
            if not found:
                continue
            # Found inside an app bundle rather than on the PATH, so the
            # command has to name it in full or the shell won't find it
            if not on_path:
                command = command.replace(binary, f'"{found}"', 1)
            return {"probe": binary, "command": command, "path": found}
        return None


# Some tools install into an app bundle and never touch the PATH. MATLAB is
# the notorious one: /Applications/MATLAB_R2025b.app/bin/matlab exists but
# `which matlab` finds nothing.
BUNDLE_SEARCH = {
    "matlab": ["/Applications/MATLAB*.app/bin/matlab"],
}


def _find_bundled(binary):
    import glob
    for pattern in BUNDLE_SEARCH.get(binary, []):
        matches = sorted(glob.glob(pattern), reverse=True)   # newest first
        if matches:
            return matches[0]
    return None


# {file} is the filename, {stem} the same without its extension.
#
# The shell command is the single source of truth — the frontend asks for it
# rather than keeping its own copy, so adding a language here is the only
# change needed to support it.
LANGUAGES = {
    ".py":    Language("Python", [("python3", "python3 {file}")],
                       run_cmd=["python3", "{file}"]),
    ".js":    Language("JavaScript", [("node", "node {file}")],
                       run_cmd=["node", "{file}"]),
    ".ts":    Language("TypeScript", [("tsx", "tsx {file}"),
                             ("ts-node", "ts-node {file}"),
                             ("deno", "deno run -A {file}")],
                       run_cmd=["tsx", "{file}"]),
    ".c":     Language("C", [("gcc", "gcc {file} -o {stem}.bin -lm && ./{stem}.bin")],
                       compile_cmd=["gcc", "{file}", "-o", "{stem}.bin", "-lm"],
                       run_cmd=["./{stem}.bin"]),
    ".cpp":   Language("C++", [("g++", "g++ -std=c++17 {file} -o {stem}.bin && ./{stem}.bin")],
                       compile_cmd=["g++", "-std=c++17", "{file}", "-o", "{stem}.bin"],
                       run_cmd=["./{stem}.bin"]),
    ".cc":    Language("C++", [("g++", "g++ -std=c++17 {file} -o {stem}.bin && ./{stem}.bin")],
                       compile_cmd=["g++", "-std=c++17", "{file}", "-o", "{stem}.bin"],
                       run_cmd=["./{stem}.bin"]),
    ".java":  Language("Java", [("javac", "javac {file} && java {stem}")],
                       compile_cmd=["javac", "{file}"], run_cmd=["java", "{stem}"]),
    ".rb":    Language("Ruby", [("ruby", "ruby {file}")], run_cmd=["ruby", "{file}"]),
    ".swift": Language("Swift", [("swift", "swift {file}")], run_cmd=["swift", "{file}"]),
    ".sh":    Language("Shell", [("bash", "bash {file}")], run_cmd=["bash", "{file}"]),
    ".zsh":   Language("Zsh", [("zsh", "zsh {file}")], run_cmd=["zsh", "{file}"]),
    ".lua":   Language("Lua", [("lua", "lua {file}")], run_cmd=["lua", "{file}"]),
    ".pl":    Language("Perl", [("perl", "perl {file}")], run_cmd=["perl", "{file}"]),
    ".php":   Language("PHP", [("php", "php {file}")], run_cmd=["php", "{file}"]),
    ".r":     Language("R", [("Rscript", "Rscript {file}")], run_cmd=["Rscript", "{file}"]),
    ".go":    Language("Go", [("go", "go run {file}")], run_cmd=["go", "run", "{file}"]),
    ".rs":    Language("Rust", [("rustc", "rustc {file} -o {stem}.bin && ./{stem}.bin")],
                       compile_cmd=["rustc", "{file}", "-o", "{stem}.bin"],
                       run_cmd=["./{stem}.bin"]),
    ".hs":    Language("Haskell", [("runghc", "runghc {file}")], run_cmd=["runghc", "{file}"]),
    ".m":     Language("MATLAB / Octave",
                       # Real MATLAB first when it is there; -batch runs a
                       # script and exits. Octave starts far faster, so it is
                       # the better day-to-day option when both exist.
                       [("matlab", 'matlab -batch "run(\'{file}\')"'),
                        ("octave", "octave --no-gui -q {file}")],
                       run_cmd=["octave", "--no-gui", "-q", "{file}"]),
    # A .sql file needs a database to run against; sqlite3 with a file beside
    # the notebook is the one that needs no setup
    ".sql":   Language("SQL (sqlite3)", [("sqlite3", "sqlite3 notebook.db < {file}")]),
}


# macOS gives an app launched from Finder a stripped PATH that usually omits
# /opt/homebrew/bin, while the cell's shell reads .zshrc and sees everything.
# Detecting against the process PATH would then report languages as missing
# that the terminal can run perfectly well, so ask the login shell instead.
_login_path = None


def login_path():
    global _login_path
    if _login_path is None:
        shell = os.environ.get("SHELL", "/bin/zsh")
        try:
            result = subprocess.run([shell, "-l", "-c", "echo $PATH"],
                                    capture_output=True, text=True, timeout=6)
            _login_path = result.stdout.strip().splitlines()[-1]
        except Exception:
            _login_path = os.environ.get("PATH", "")
    return _login_path


def language_for(filename):
    return LANGUAGES.get(os.path.splitext(filename)[1].lower())


def available_languages():
    """Which languages this machine can run, and the command to run them."""
    path = login_path()
    out = {}
    for extension, lang in LANGUAGES.items():
        found = lang.resolve(path)
        out[extension] = {
            "name": lang.name,
            "available": found is not None,
            "probe": (found or {}).get("probe", lang.probe),
            "command": (found or {}).get("command", lang.command),
            "resolvedPath": (found or {}).get("path"),
        }
    return out


def _snapshot(folder):
    """path -> mtime+size, so we can tell afterwards what the run produced."""
    seen = {}
    for entry in os.scandir(folder):
        if entry.is_file():
            stat = entry.stat()
            seen[entry.name] = (stat.st_mtime_ns, stat.st_size)
    return seen


def _collect_artefacts(folder, before):
    """Files the run created or changed that we can display as a tab."""
    artefacts = []
    for entry in sorted(os.scandir(folder), key=lambda e: e.name):
        if not entry.is_file():
            continue
        extension = os.path.splitext(entry.name)[1].lower()
        if extension not in VIEWABLE:
            continue

        stat = entry.stat()
        if before.get(entry.name) == (stat.st_mtime_ns, stat.st_size):
            continue                      # untouched by this run
        if stat.st_size > MAX_ARTEFACT_BYTES:
            continue

        with open(entry.path, "rb") as handle:
            data = base64.b64encode(handle.read()).decode("ascii")
        mime, _ = mimetypes.guess_type(entry.name)
        artefacts.append({
            "name": entry.name,
            "mime": mime or "application/octet-stream",
            "data": data,
        })
    return artefacts


def run_code(filename, source, stdin_text="", workdir=None, timeout=DEFAULT_TIMEOUT):
    """Compile if needed, run, and report output plus any files produced."""
    language = language_for(filename)
    if language is None:
        return {"ok": False, "stdout": "", "exitCode": None, "artefacts": [],
                "stderr": f"No runner for '{os.path.splitext(filename)[1]}' files."}

    binary = language.probe
    installed = os.path.isfile(binary) if os.path.isabs(binary) else shutil.which(binary)
    if not installed:
        return {"ok": False, "stdout": "", "exitCode": None, "artefacts": [],
                "stderr": f"{language.name} needs '{language.probe}', which isn't installed."}

    folder = workdir or tempfile.mkdtemp(prefix="ntbk_run_")
    os.makedirs(folder, exist_ok=True)
    stem = os.path.splitext(os.path.basename(filename))[0]

    body = source
    if filename.endswith(".py"):
        body = source + "\n" + MATPLOTLIB_EPILOGUE
    path = os.path.join(folder, os.path.basename(filename))
    with open(path, "w") as handle:
        handle.write(body)

    def substitute(cmd):
        return [part.format(file=os.path.basename(filename), stem=stem) for part in cmd]

    before = _snapshot(folder)
    started = time.time()

    try:
        if language.compile_cmd:
            compiled = subprocess.run(
                substitute(language.compile_cmd), cwd=folder,
                capture_output=True, text=True, timeout=timeout)
            if compiled.returncode != 0:
                return {"ok": False, "stdout": compiled.stdout,
                        "stderr": compiled.stderr or "Compilation failed.",
                        "exitCode": compiled.returncode, "artefacts": [],
                        "durationMs": int((time.time() - started) * 1000),
                        "stage": "compile"}

        result = subprocess.run(
            substitute(language.run_cmd), cwd=folder, input=stdin_text,
            capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "stdout": "", "exitCode": None, "artefacts": [],
                "stderr": f"Timed out after {timeout}s.",
                "durationMs": timeout * 1000, "stage": "run"}
    except Exception as error:
        return {"ok": False, "stdout": "", "exitCode": None, "artefacts": [],
                "stderr": str(error), "stage": "run"}

    return {
        "ok": result.returncode == 0,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exitCode": result.returncode,
        "durationMs": int((time.time() - started) * 1000),
        "artefacts": _collect_artefacts(folder, before),
        "stage": "run",
    }
