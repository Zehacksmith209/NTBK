# Files and format

## Where your things live

| | |
|---|---|
| `Thermo.ntbk` | the notebook itself |
| `Thermo.files/` | code-cell sources, mirrored as real files beside it |
| `shapes/` | custom shapes saved while this notebook was open |
| `~/Documents/ntbk/shapes/` | your personal shape library, always available |

Everything is a plain file you can open, copy, back up or put in git. Nothing is
hidden in a database or a cloud account.

## What a `.ntbk` is

A **zip**. Rename one to `.zip` and open it:

```
document.json     the whole notebook
assets/           images and PDFs, byte-for-byte as you imported them
```

To read one without ntbk:

```bash
unzip -p Thermo.ntbk document.json | python3 -m json.tool | less
```

## document.json

```json
{
  "format": "ntbk",
  "schemaVersion": 1,
  "meta": { "title": "Electromagnetism", "created": "…", "modified": "…" },
  "canvas": {
    "layers":     [ { "id": "ly_…", "name": "Working", "visible": true, "locked": false } ],
    "pages":      [ { "id": "pg_01", "index": 0, "x": 0, "y": 0, "w": 794, "h": 1123 } ],
    "background": { "type": "grid", "spacing": 20, "color": "#e9e9ee" }
  },
  "strokes": [ … ],
  "objects": [ … ],
  "assets":  [ … ]
}
```

**Pages are A4 at 96 dpi** — 794 × 1123 px is exactly 210 × 297 mm. So 1 cm is
37.8 px, which is why the ruler can be honest about centimetres.

### Strokes

Ink, highlighter and drawn shapes. Points are flat triples:

```json
{
  "id": "st_…", "kind": "pen", "layerId": "ly_…",
  "stride": 3,
  "points": [x, y, pressure,  x, y, pressure,  …],
  "style": { "color": "#111111", "size": 3, "opacity": 1 },
  "erase": []
}
```

`kind` is `pen`, `highlighter` or `shape`. A `shape` also carries `shape`
(`rect`, `ellipse`, `line`, `arrow`, `triangle`) and a `name`.

`erase` holds **subtractive masks** rather than edited points — erasing never
destroys the original stroke, which is why an erased stroke can still be
restyled and rescaled.

`groupId`, when present, ties several strokes together as one placed custom
shape.

### Objects

Formulas, plots, text, code cells, images, PDF pages. All share a frame and
differ only in `payload`:

```json
{
  "id": "ob_…", "type": "latex", "name": "Gauss's law",
  "layerId": "ly_…", "band": "under",
  "x": 70, "y": 290, "w": 290, "h": 80,
  "payload": { "source": "\\oint \\vec{E}\\cdot d\\vec{A} = …" }
}
```

| `type` | `payload` holds |
|---|---|
| `latex` | `source` |
| `text` | `html`, `fontSize`, `color` |
| `graph` | `kind`, `functions` or `surfaces`, `bounds`, `view` |
| `code` | `filename`, `source`, `runCommand`, `transcript` |
| `image` | `asset`, `naturalW`, `naturalH`, `mime` |
| `pdfpage` | `asset`, `page`, `source` |

`band` is `under` or `over`: whether your pen lands on top of it or beneath it.

Adding a new object type means adding a `type` string and a renderer — never a
format migration. That is what keeps the format additive.

## Custom shapes

One `.ntbkshape` file per shape — plain JSON, named after what you called it:

```json
{
  "name": "Free body",
  "aspect": 1.4,
  "strokes": [ { "kind": "pen", "stride": 3, "points": [ … ], "style": { … } } ]
}
```

Points are **normalised to 0–1**, which is why a shape drops in at any size
without distortion. One file per shape is deliberate: it is what lets you drag
them between folders to carry them to a new topic.

## Code cell sources

Every code cell is mirrored to a real file in `<name>.files/`, so `main.py` in a
cell is `Thermo.files/main.py` on disk. Open it in any editor; it is not a copy
in a database.

That folder is also the working directory when a cell runs, so files your code
writes land beside it.

## Sharing a notebook

Send the `.ntbk` — it carries every image and PDF inside it, so nothing goes
missing. Two things do **not** travel:

- `<name>.files/` — recreated from the cells on the other side
- Your custom shape library — placed shapes still draw correctly, since they
  are stored as ordinary strokes; only the reusable library entry is local

**Code cells never run on open.** A notebook from someone else runs nothing until
you press Run.

## Compatibility

`schemaVersion` is checked on open. A file from a newer version than your build
understands is refused with a clear message rather than being read wrongly.

Unknown fields are preserved on load and save, so an older build will not strip
data a newer one wrote.
