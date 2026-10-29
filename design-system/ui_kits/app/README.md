# Reflect App — UI kit

An interactive recreation of Reflect's desktop notes app, composed from the design
system primitives (`Button`, `SearchField`, `IconButton`, `MenuItem`, `ShortcutKey`,
`Checkbox`, `Avatar`, `Card`).

## Run
Open `index.html`. It loads the compiled `_ds_bundle.js` plus the kit's own Babel
files and mounts `AppShell`.

## What's interactive
- **Sidebar nav** — Daily notes / All notes / Tasks / Map switch the main view.
- **⌘K (or click the search field)** — opens the command-search modal; type to filter,
  `Esc` to close, click a result to jump.
- **Checkboxes** — toggle tasks inline (daily notes + Tasks view).
- **Backlinks & pinned notes** — click to open the corresponding note in All notes.

## Fidelity notes
This mirrors layout, hierarchy and the real interaction model (daily-notes-first,
backlinks, ⌘K, the grey hover wash, indigo selected state). The actual product uses a
rich ProseMirror editor (`@team-reflect/reflect-editor`) — here the "editor" is static
styled prose. Dark mode is available by adding `class="dark"` to a wrapper.
