# Change Log

## 0.1.0 — Initial release as Strander

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