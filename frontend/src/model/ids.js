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
