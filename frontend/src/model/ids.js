// Short sortable-ish ids. Prefixed so a raw id tells you what it points at.
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

let counter = 0;

export function newId(prefix) {
  const time = Date.now().toString(36);
  const seq = (counter++ % 1296).toString(36).padStart(2, "0");
  let rand = "";
  for (let i = 0; i < 4; i++) {
    rand += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${prefix}_${time}${seq}${rand}`;
}

/**
 * A real UUID, for the notebook itself.
 *
 * newId() above is short and readable, which is right for things that only
 * ever mean something inside one file. A notebook's identity is different:
 * a graph that one day reaches ACROSS notebooks has to name them by something
 * that cannot collide with another machine's ids, and cannot be a file path,
 * because renaming a notebook would break every link pointing into it.
 */
export function newUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Older webviews: RFC-4122 v4 from getRandomValues, or Math.random as a
  // last resort. Uniqueness matters here; cryptographic quality does not.
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0,4).join("")}-${hex.slice(4,6).join("")}-`
       + `${hex.slice(6,8).join("")}-${hex.slice(8,10).join("")}-${hex.slice(10).join("")}`;
}
