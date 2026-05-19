# Strander

> Plain-text in. Diagram out. Drag, drop, theme, ship.

Strander is a Visual Studio Code extension that brings the wonderful authoring
experience of [Flowchart.fun] to your editor. Write a `.strand` file in human
syntax, hit `Open Visual Editor`, and a split-view live diagram pops up beside
your text - fully interactive, fully themable, fully yours.

---

## ✨ Features

- **Split-view editing.** Text on one side, diagram on the other. Edit either; both stay in sync.
- **Drag-and-drop layout.** Pin nodes by hand or let one of 5 layout engines (Dagre, ELK, fCoSE, CoSE-Bilkent, Klay) do the work.
- **Auto-Layout mode toggle.** Freeze your layout, or let it flow.
- **Sidecar metadata.** Layout, custom CSS, and node positions live in `*.strand.meta`, kept out of your source file and auto-nested in the Explorer.
- **Rich context menus.** Add nodes, change shapes, recolor, restyle lines - directly from the canvas.
- **Per-file settings modal** - fonts, spacing, edge curve, padding, layout direction, theme colors, custom CSS, and more.
- **Material Symbols icons.** `[icon=router]`, `[icon=database]`, anywhere. Per-class color inheritance included.
- **Pipe-to-newline labels.** `Website | website.example.com` becomes a two-line label.
- **Auto IDs.** Reference nodes by their label slug - `(#website)` resolves to the node labeled `Website`.
- **CSS class references.** `(.public)` resolves to every `.public` node.
- **Leading references** for many-to-one edges.
- **Live syntax error reporting** in both editors.
- **Document formatter.** Cleans up your indentation.
- **Custom file icon** and TextMate grammar with class/escape highlighting.

---

## 🚀 Quick Start

1. Install the extension.
2. `File > New File`, save as `diagram.strand`.
3. Type:
   ```
   Hello
     World
       Goodbye
   ```
4. Right-click the file → **Open With… → Strander Visual Editor**, or run
   **Strander: Open Visual Editor** from the Command Palette.
5. Drag, drop, theme, ship.

---

## 📐 Syntax (cheat sheet)

```
// Comments

Parent {
  Child A
  Child B [icon=database] #db
}

Other Group {
  Service [icon=router] .public
  Worker .public
}

// Pipe newlines
Website | website.example.com [icon=public] #website .public

// Edges
A -> B: optional edge label
A -- B
A: just a label edge to B

// Leading reference (many-to-one)
(.public)
  routes through to: (#db)
```

See [Flowchart.fun's syntax docs][docs] for the full grammar. 
Strander aims
for 100% rendering parity.

---

## ⚙️ Settings

Click the gear icon in the visual editor for the per-file settings modal:

- **Layout:** algorithm, direction, spacing factor, edge curve
- **Nodes:** padding, font family, font size, font weight, colors, line thickness
- **Icons:** width, height, placement (before / after / above / below), spacing
- **Custom CSS:** drop in Cytoscape selectors - `.my-class { background-color: #f00; }`

All settings persist to `<your-file>.strand.meta`.

---

## 🗂 File nesting

Strander tells VS Code to auto-nest `*.strand.meta` under `*.strand` so your
Explorer stays tidy. This is enabled in the extension's
`configurationDefaults`.

---

## 🛠 Building locally

```bash
git clone https://github.com/BlazingCacti/Strander.git
cd strander
npm ci

# Build a production .vsix for marketplace publishing
npm run package

# Build and install into VS Code Insiders for local testing
npm run install-local
```

The two build scripts live in `scripts/`:

- `scripts/build-prod.sh` - clean install, build, package `.vsix`.
- `scripts/build-install-insiders.sh` - build, package, drop into
  `~/.vscode[-server][-insiders]/extensions/strander-<version>/`.

---

## 🙏 Credits

Strander is **based on [Flowchart.fun]** by Tone Row, an open-source project
that pioneered the text-to-flowchart authoring model and provides the
[`graph-selector`] parser this extension uses. Huge thanks to the
Flowchart.fun maintainers for the syntax and inspiration. See
[NOTICE](./NOTICE) for full attribution.

Strander is not affiliated with or endorsed by Tone Row or Flowchart.fun.

---

## 📜 License

MIT - see [LICENSE](./LICENSE).

[Flowchart.fun]: https://flowchart.fun
[docs]: https://flowchart.fun/blog/post/syntax
[`graph-selector`]: https://www.npmjs.com/package/graph-selector
