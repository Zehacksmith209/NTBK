import { registerObjectType } from "./registry.js";
import { createObject } from "../model/document.js";
import { bridge } from "../bridge.js";

// ─────────────────────────────────────────────
//  VIDEO
//
//  A video from the internet, playing inside the
//  page. This is the first thing in the notebook
//  that needs a connection, so the object stores
//  only the address: nothing is downloaded into
//  the .ntbk, and with no connection the box says
//  so instead of showing an empty frame.
//
//  It has two states. At rest it is a still cover
//  with a play button, and behaves like any other
//  box: it can be selected, dragged and drawn
//  over. Playing, it is a real player in an
//  <iframe>, which takes every click and scroll
//  that lands on it. The title bar stays outside
//  the player, so the box can still be moved and
//  the player can be put away again.
// ─────────────────────────────────────────────

const HEAD_HEIGHT = 26;

/**
 * Work out how to play an address.
 *
 * Kept as a function of the URL rather than saved in the document, so a
 * notebook written today picks up any site added here later.
 */
export function parseVideoUrl(raw) {
  const text = String(raw ?? "").trim();
  // The URL parser is forgiving to a fault: it accepts "not a link at all" by
  // percent-encoding the spaces into a hostname. A real address has no
  // spaces and a dot in its host, so those are checked by hand.
  if (!text || /\s/.test(text)) return null;
  let url;
  try {
    url = new URL(text.replace(/^(?!https?:\/\/)/i, "https://"));
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return null;
  const host = url.hostname.replace(/^(www|m|music)\./, "").toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const clean = (id) => (id && /^[\w-]+$/.test(id) ? id : null);

  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
    let id = null;
    let vertical = false;
    if (host === "youtu.be") id = parts[0];
    else if (parts[0] === "watch") id = url.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(parts[0])) {
      id = parts[1];
      vertical = parts[0] === "shorts";
    }
    id = clean(id);
    if (!id) return null;
    const start = seconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
    const query = new URLSearchParams({ autoplay: "1", rel: "0", playsinline: "1" });
    if (start) query.set("start", String(start));
    return {
      provider: "YouTube", kind: "frame", vertical,
      embed: `https://www.youtube.com/embed/${id}?${query}`,
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = clean(parts.filter((p) => /^\d+$/.test(p)).pop());
    if (!id) return null;
    return { provider: "Vimeo", kind: "frame", vertical: false,
             embed: `https://player.vimeo.com/video/${id}?autoplay=1`, thumb: null };
  }

  if (host === "dailymotion.com" || host === "dai.ly") {
    const id = clean(host === "dai.ly" ? parts[0] : parts[parts.indexOf("video") + 1]);
    if (!id) return null;
    return { provider: "Dailymotion", kind: "frame", vertical: false,
             embed: `https://www.dailymotion.com/embed/video/${id}?autoplay=1`,
             thumb: `https://www.dailymotion.com/thumbnail/video/${id}` };
  }

  if (host === "tiktok.com") {
    const id = clean(parts[parts.indexOf("video") + 1]);
    if (!id || !/^\d+$/.test(id)) return null;
    return { provider: "TikTok", kind: "frame", vertical: true,
             embed: `https://www.tiktok.com/player/v1/${id}?autoplay=1`, thumb: null };
  }

  if (host === "instagram.com" && ["reel", "reels", "p", "tv"].includes(parts[0])) {
    const id = clean(parts[1]);
    if (!id) return null;
    return { provider: "Instagram", kind: "frame", vertical: true,
             embed: `https://www.instagram.com/reel/${id}/embed`, thumb: null };
  }

  if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(url.pathname)) {
    return { provider: "Video file", kind: "file", vertical: false,
             embed: url.href, thumb: null };
  }

  // Anything else is tried as it stands. Plenty of sites refuse to be shown
  // inside another page, and there is no way to tell in advance which.
  return { provider: host, kind: "frame", vertical: false, embed: url.href,
           thumb: null, unknown: true };
}

/** "90", "1m30s" or "1h2m3s" as a number of seconds. */
function seconds(text) {
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

export function createVideoObject(x, y, url) {
  const info = parseVideoUrl(url);
  const w = info?.vertical ? 270 : 480;
  const h = (info?.vertical ? 480 : 270) + HEAD_HEIGHT;
  return createObject({ type: "video", x, y, w, h, payload: { url: String(url).trim() } });
}

registerObjectType("video", {
  mount(el, object) {
    el.classList.add("ntbk-video");
    el.innerHTML = `
      <div class="ntbk-video-head">
        <span class="ntbk-video-site"></span>
        <span class="ntbk-video-url"></span>
        <button class="ntbk-video-btn" data-open title="Open in your browser">↗</button>
        <button class="ntbk-video-btn" data-stop title="Stop and put the player away" hidden>■</button>
      </div>
      <div class="ntbk-video-body"></div>`;

    const site = el.querySelector(".ntbk-video-site");
    const address = el.querySelector(".ntbk-video-url");
    const body = el.querySelector(".ntbk-video-body");
    const stopButton = el.querySelector("[data-stop]");
    const openButton = el.querySelector("[data-open]");

    let shownUrl = null;
    let info = null;
    let playing = false;

    // The buttons are controls, not part of the box you drag
    for (const button of [stopButton, openButton]) {
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
    }
    stopButton.addEventListener("click", (event) => { event.stopPropagation(); rest(); });
    openButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (shownUrl) bridge.openUrl(shownUrl);
    });

    /** The still cover: selectable, draggable, and safe to draw over. */
    function rest() {
      playing = false;
      stopButton.hidden = true;
      el.classList.remove("is-playing");
      body.innerHTML = "";

      const cover = document.createElement("div");
      cover.className = "ntbk-video-cover";
      if (info?.thumb) cover.style.backgroundImage = `url("${info.thumb}")`;

      if (!info) {
        cover.classList.add("is-bad");
        cover.textContent = "This address is not a video link";
      } else {
        const play = document.createElement("button");
        play.className = "ntbk-video-play";
        play.title = "Play";
        play.textContent = "▶";
        play.addEventListener("pointerdown", (event) => event.stopPropagation());
        play.addEventListener("click", (event) => { event.stopPropagation(); start(); });
        cover.appendChild(play);

        const hint = document.createElement("div");
        hint.className = "ntbk-video-note";
        hint.textContent = navigator.onLine === false
          ? "Needs an internet connection"
          : info.unknown ? "This site may refuse to play inside the notebook" : "";
        if (hint.textContent) cover.appendChild(hint);
      }
      body.appendChild(cover);
    }

    /** The live player. From here on the frame owns every click inside it. */
    function start() {
      if (!info) return;
      playing = true;
      stopButton.hidden = false;
      el.classList.add("is-playing");
      body.innerHTML = "";

      let player;
      if (info.kind === "file") {
        player = document.createElement("video");
        player.controls = true;
        player.autoplay = true;
        player.src = info.embed;
      } else {
        player = document.createElement("iframe");
        player.allow = "autoplay; fullscreen; picture-in-picture; encrypted-media";
        player.allowFullscreen = true;
        // YouTube refuses to play for a page that sends no referrer at all
        player.referrerPolicy = "strict-origin-when-cross-origin";
        player.src = info.embed;
      }
      player.className = "ntbk-video-player";
      // A player that let these through would start a pen stroke or a canvas
      // pan under the cursor every time the video was clicked.
      for (const type of ["pointerdown", "pointermove", "pointerup", "wheel", "dblclick"]) {
        player.addEventListener(type, (event) => event.stopPropagation());
      }
      body.appendChild(player);
    }

    function apply(next) {
      const url = next.payload?.url ?? "";
      if (url === shownUrl) return;        // a move or resize must not restart the video
      shownUrl = url;
      info = parseVideoUrl(url);
      site.textContent = info?.provider ?? "Video";
      address.textContent = url.replace(/^https?:\/\/(www\.)?/, "");
      address.title = url;
      rest();
    }

    el.addEventListener("dblclick", (event) => {
      if (playing) return;
      event.stopPropagation();
      start();
    });

    apply(object);
    return {
      update: apply,
      destroy() { body.innerHTML = ""; },
    };
  },
});
