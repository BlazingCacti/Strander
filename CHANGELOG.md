# Change Log

## 0.2.0 — `[iconfile]` + pre-release builds

- **New: `[iconfile=...]`** — load any local image file (SVG, PNG, JPG, GIF,
  WebP) as a node icon. Paths are resolved relative to the `.strand` file
  with Linux / macOS / Windows path styles all accepted; SVGs are tinted to
  the node's text color, like Material Symbols icons.
- Build scripts now support `--pre-release` (`npm run package:pre`,
  `npm run install-local:pre`) for the VS Code Marketplace pre-release channel.

## 0.1.1 - Publishing Corrections

- Updated package metadata for publishing (description, keywords, publisher id).

- Updated Logo

## 0.1.0 - Initial release as Strander

- Rebranded from `flowchat-code` to **Strander**.
- File extension changed to `.strand` (sidecar metadata: `.strand.meta`).
- 100% Flowchart.fun-syntax parser via `graph-selector`.
- Split-view text + visual editor with bidirectional sync.
- Drag-and-drop nodes; Auto-Layout toggle (Dagre / ELK / fCoSE / CoSE-Bilkent / Klay).
- Per-file settings modal (layout, fonts, padding, edge curve, icons, custom CSS).
- Material Symbols icons via `[icon=name]`, color inheritance per node.
- Pipe `|` as label newline.
- Auto-IDs derived from labels for `(#slug)` references.
- CSS class references `(.class)` and leading references for many-to-one edges.
- Live syntax error reporting.
- Document formatter.
- File nesting (`*.strand` → `*.strand.meta`) enabled by default.