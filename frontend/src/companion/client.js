// ─────────────────────────────────────────────
//  COMPANION CLIENT
//
//  What runs when the frontend is loaded over
//  the LAN instead of inside pywebview.
//
//  Same bundle, same renderer, same everything —
//  only the transport differs. The desktop talks
//  to Python through the pywebview bridge; this
//  talks to the same Python over HTTP.
// ─────────────────────────────────────────────

const TOKEN_KEY = "ntbk-companion-token";

/**
 * Is this the tablet, rather than the laptop?
 *
 * Must NOT be answered synchronously. pywebview injects `window.pywebview`
 * asynchronously — bridge.whenReady() exists precisely because of that — so a
 * check at script time says "no Python" inside the desktop app and shows the
 * pairing screen to the very machine holding the code.
 *
 * The protocol is no help either: pywebview serves the desktop app from its
 * own bundled bottle server, so location.protocol is "http:" on BOTH.
 *
 * The only honest signal is whether the bridge ever appears.
 */
export async function isCompanion(ready) {
  if (await ready) return false;            // the bridge appeared: this is the laptop
  // No bridge could still mean a plain dev server rather than a paired
  // tablet, so ask whether a companion server is actually answering. A
  // pairing screen on `npm run dev` would be a puzzle with no solution.
  try {
    const response = await fetch("/pair", { method: "OPTIONS" });
    // "ok" alone is not enough: a dev server answers OPTIONS on any path with
    // an empty 204. The companion server answers this one with JSON.
    return response.ok
      && (response.headers.get("content-type") ?? "").includes("application/json");
  } catch {
    return false;
  }
}

export class CompanionClient {
  constructor() {
    this.token = null;
    try { this.token = localStorage.getItem(TOKEN_KEY); } catch { /* private mode */ }
    this.events = null;
    this.listeners = new Set();
    this.state = "offline";          // offline | connecting | connected
    this.pending = 0;
  }

  onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _status(state, pending = this.pending) {
    this.state = state;
    this.pending = pending;
    for (const fn of this.listeners) fn(state, pending);
  }

  async pair(code) {
    const response = await fetch("/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: String(code).trim() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      return { ok: false, error: body.error ?? `Pairing failed (${response.status})` };
    }
    this.token = body.token;
    try { localStorage.setItem(TOKEN_KEY, this.token); } catch { /* private mode */ }
    return { ok: true };
  }

  forget() {
    this.token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }

  async document() {
    const response = await fetch(`/document?token=${encodeURIComponent(this.token)}`);
    if (response.status === 401) { this.forget(); throw new Error("unpaired"); }
    if (!response.ok) throw new Error(`document ${response.status}`);
    return response.json();
  }

  /**
   * Listen for what the laptop sends.
   *
   * EventSource rather than a WebSocket: the only thing needing push here is
   * laptop -> device, EventSource reconnects on its own (which iOS forces you
   * to handle regardless), and it costs no dependency because bottle already
   * ships with pywebview. A WebSocket earns its place when code-cell output
   * has to stream back, not before.
   */
  listen(onMessage) {
    if (!this.token) return;
    this.events?.close();
    this._status("connecting");
    const source = new EventSource(`/events?token=${encodeURIComponent(this.token)}`);
    this.events = source;

    source.onopen = () => this._status("connected");
    source.onmessage = (event) => {
      try { onMessage(JSON.parse(event.data)); } catch { /* ignore junk */ }
    };
    source.onerror = () => {
      // EventSource retries by itself; say "reconnecting", never "error".
      // On a tablet this happens constantly and it is not a fault.
      this._status(this.token ? "connecting" : "offline");
    };
  }

  stop() {
    this.events?.close();
    this.events = null;
    this._status("offline");
  }

  /** Send commands. Returns which ids the laptop accepted. */
  async send(commands) {
    if (!this.token || !commands.length) return [];
    const response = await fetch("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ntbk-token": this.token },
      body: JSON.stringify({ commands }),
    });
    if (!response.ok) throw new Error(`send ${response.status}`);
    const body = await response.json();
    return body.applied ?? [];
  }
}

/* ── Pairing screen ─────────────────────────
   Shown before anything else when this device has no token. */
export function askToPair(client) {
  return new Promise((resolve) => {
    const screen = document.createElement("div");
    screen.className = "ntbk-pair";
    screen.innerHTML = `
      <div class="ntbk-pair-card">
        <h1>ntbk</h1>
        <p>Enter the 6-digit code shown on your laptop.</p>
        <input class="ntbk-pair-code" type="text" inputmode="numeric"
               maxlength="6" autocomplete="one-time-code" placeholder="000000">
        <button class="ntbk-pair-go">Connect</button>
        <div class="ntbk-pair-error"></div>
      </div>`;
    document.body.appendChild(screen);

    const field = screen.querySelector(".ntbk-pair-code");
    const go = screen.querySelector(".ntbk-pair-go");
    const error = screen.querySelector(".ntbk-pair-error");

    const attempt = async () => {
      go.disabled = true;
      error.textContent = "";
      const result = await client.pair(field.value).catch((e) => ({ ok: false, error: String(e.message) }));
      go.disabled = false;
      if (!result.ok) {
        error.textContent = result.error;
        field.select();
        return;
      }
      screen.remove();
      resolve();
    };

    go.addEventListener("click", attempt);
    field.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
    field.focus();
  });
}

/* ── Status, and it has to be honest ────────
   The worst outcome is a student who believes their notes are safe when they
   are stranded on a tablet. So: three real states, never a silent failure. */
export function mountStatus(client) {
  const chip = document.createElement("div");
  chip.className = "ntbk-companion-status";
  document.body.appendChild(chip);

  let settleTimer = null;
  client.onStatus((state, pending) => {
    chip.dataset.state = state;
    if (state === "connected" && !pending) {
      chip.textContent = "Synced";
      chip.classList.add("is-quiet");
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => chip.classList.add("is-faded"), 1800);
      return;
    }
    chip.classList.remove("is-quiet", "is-faded");
    chip.textContent = state === "connected"
      ? `Connected · ${pending} pending`
      : state === "connecting"
        ? "Reconnecting…"
        : `Offline${pending ? ` · ${pending} change${pending === 1 ? "" : "s"} pending` : ""}`;
  });
  return chip;
}
