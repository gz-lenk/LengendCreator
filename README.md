# Nested Page Tree

Nested Page Tree is an Obsidian plugin that presents ordinary Markdown notes as an arbitrarily nestable page tree. The tree is reconstructed from YAML properties in the notes; plugin data only stores settings and expanded UI state.

## Features

- Custom page tree in the left sidebar.
- Create root pages and child pages without managing folders.
- Open, rename and delete managed pages.
- Drag a page onto another page to make it a child.
- Drag near the top or bottom of a page to reorder it among siblings.
- Detect missing parents and cycles without hiding affected notes.
- Adopt an existing Markdown note from the native file menu.
- React to external YAML edits, file renames and file deletions.
- Hide plugin-managed properties above the note while keeping their YAML data intact.
- Mirror the logical page tree into ordinary folders under `main`.
- Works without Node.js or desktop-only APIs at runtime.

## Storage

Pages remain ordinary Markdown files. The plugin owns the `main` folder and derives its physical layout from the logical page tree:

```text
main/
  Home/
    Home.md
    Child 1.md
    Child 2/
      Child 2.md
      Grandchild.md
  Another root.md
```

A leaf page is stored directly as `Page title.md`. As soon as it gains a child, it is promoted to `Page title/Page title.md`; when its last child leaves, it is demoted to a single Markdown file again. Users can therefore work entirely in the page tree without managing folders.

The logical hierarchy is stored as YAML:

```yaml
---
page-tree: true
page-tree-id: 78df83c4-5ba3-4cf7-8d08-143a079ce721
page-tree-parent: 50cc3318-8d7e-4bf6-9099-b94fae8f7703
page-tree-order: 2048
title: Northern Kingdom
---
```

Root pages omit `page-tree-parent`. A stable ID keeps the hierarchy intact when a file is renamed or moved. Duplicate IDs caused by copying a managed note are repaired when the index is rebuilt.

## Usage

Enable the plugin and open **Nested Page Tree: Open page tree** from the command palette. Use the plus button to create a root page, or open a page's context menu to create a child.

During drag and drop:

- Drop in the middle of a row to make the page a child.
- Drop near the top or bottom edge to place it before or after that page.
- Drop on the **Move to root** target to return it to the top level.

Existing Markdown notes can be added through the native file explorer context menu. Once adopted, the plugin moves them into the managed `main` layout.

## Development

The plugin intentionally ships as plain JavaScript, so Obsidian can load it directly without a local build toolchain.

```sh
npm run check
npm test
```

Runtime files are `manifest.json`, `main.js`, and `styles.css`.
