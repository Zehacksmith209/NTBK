// ─────────────────────────────────────────────
//  PDF PAGE PICKER
//
//  Thumbnails to click, plus a range box for
//  long documents where clicking forty pages
//  would be miserable.
// ─────────────────────────────────────────────

/** "1-3, 7, 12-15" -> Set{1,2,3,7,12,13,14,15}, ignoring anything out of range. */
export function parseRange(text, pageCount) {
  const chosen = new Set();
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Math.max(1, Number(range[1]));
      const to = Math.min(pageCount, Number(range[2]));
      for (let i = from; i <= to; i++) chosen.add(i);
    } else if (/^\d+$/.test(piece)) {
      const n = Number(piece);
      if (n >= 1 && n <= pageCount) chosen.add(n);
    }
  }
  return chosen;
}

export function openPdfDialog({ fileName, pageCount, renderThumb, onInsert }) {
  const overlay = document.createElement("div");
  overlay.className = "ntbk-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "ntbk-modal";
  modal.innerHTML = `
    <div class="ntbk-modal-head">
      <strong>Insert PDF printout</strong>
      <span class="ntbk-modal-sub"></span>
      <button class="ntbk-modal-close" title="Cancel">✕</button>
    </div>
    <div class="ntbk-modal-controls">
      <label>Pages</label>
      <input class="ntbk-range" type="text" placeholder="all — or 1-3, 7, 12-15">
      <button class="ntbk-mini" data-all>All</button>
      <button class="ntbk-mini" data-none>None</button>
      <span class="ntbk-count"></span>
    </div>
    <div class="ntbk-thumbs"></div>
    <div class="ntbk-modal-foot">
      <label>Place as</label>
      <select class="ntbk-placement">
        <option value="pages">New notebook pages, one per PDF page</option>
        <option value="stacked">Stacked here on the canvas</option>
      </select>
      <button class="ntbk-primary" data-insert>Insert</button>
    </div>`;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modal.querySelector(".ntbk-modal-sub").textContent =
    `${fileName} · ${pageCount} page${pageCount === 1 ? "" : "s"}`;

  const thumbs = modal.querySelector(".ntbk-thumbs");
  const rangeInput = modal.querySelector(".ntbk-range");
  const countLabel = modal.querySelector(".ntbk-count");
  const selected = new Set(Array.from({ length: pageCount }, (_, i) => i + 1));
  const tiles = new Map();

  function refresh() {
    for (const [page, tile] of tiles) {
      tile.classList.toggle("is-on", selected.has(page));
    }
    countLabel.textContent = `${selected.size} selected`;
    modal.querySelector("[data-insert]").disabled = selected.size === 0;
  }

  for (let page = 1; page <= pageCount; page++) {
    const tile = document.createElement("button");
    tile.className = "ntbk-thumb";
    tile.innerHTML = `<div class="ntbk-thumb-img"></div><span>${page}</span>`;
    tile.addEventListener("click", () => {
      selected.has(page) ? selected.delete(page) : selected.add(page);
      rangeInput.value = "";
      refresh();
    });
    thumbs.appendChild(tile);
    tiles.set(page, tile);

    // Thumbnails stream in as they render, so a long PDF stays responsive
    renderThumb(page).then((url) => {
      if (!url) return;
      const holder = tile.querySelector(".ntbk-thumb-img");
      const img = document.createElement("img");
      img.src = url;
      holder.appendChild(img);
    }).catch(() => {});
  }
  refresh();

  rangeInput.addEventListener("input", () => {
    const text = rangeInput.value.trim();
    selected.clear();
    if (!text) {
      for (let i = 1; i <= pageCount; i++) selected.add(i);
    } else {
      for (const page of parseRange(text, pageCount)) selected.add(page);
    }
    refresh();
  });

  modal.querySelector("[data-all]").addEventListener("click", () => {
    rangeInput.value = "";
    for (let i = 1; i <= pageCount; i++) selected.add(i);
    refresh();
  });
  modal.querySelector("[data-none]").addEventListener("click", () => {
    rangeInput.value = "";
    selected.clear();
    refresh();
  });

  const close = () => overlay.remove();
  modal.querySelector(".ntbk-modal-close").addEventListener("click", close);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener("keydown", function escape(event) {
    if (event.key === "Escape") { close(); window.removeEventListener("keydown", escape); }
  });

  modal.querySelector("[data-insert]").addEventListener("click", () => {
    const pages = [...selected].sort((a, b) => a - b);
    const placement = modal.querySelector(".ntbk-placement").value;
    close();
    onInsert(pages, placement);
  });

  return { close };
}
