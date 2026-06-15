# Editor architecture

A map of `apps/desktop/src/editor/` for contributors. The design docs are
Plans 05/05b (editor + fidelity), 06 (daily notes), and 07/07b (backlinks,
renames); this is the orientation layer those plans don't give you.

## The layers

```text
NotePane / DailyStream / MobileNote     components — composition only
  ├─ useNoteDocument()                  React adapter (use-note-document.ts)
  │    ├─ createDocumentBinding()       create/adopt/teardown/hand-off policy
  │    └─ createNoteSession()           pure document state machine (note-session.ts)
  │         └─ readNote / writeNote     @reflect/core typed commands
  ├─ useWikiLinkNavigation()            [[link]] click → route / create
  ├─ useImagePersistence()              paste/drop → assets/ write
  └─ <NoteEditor>                       meowdown + our extensions (note-editor.tsx)
```

The load-bearing split is **session vs. adapter**: `note-session.ts` owns every
save/conflict/protection rule as a pure state machine — no React, no editor, no
IPC (file access is injected) — and `use-note-document.ts` only wires it to
React state, the `@reflect/core` commands, the watcher stream, and the editor's
imperative handle. `document-binding.ts` owns the pane lifecycle around that
session: create, adopt after a rename-following route change, teardown, and the
microtask hand-off when a moved note is not adopted. Tests drive the session
and binding directly with fake IO (`note-session.test.ts`,
`document-binding.test.ts`); if you're changing *what happens*, you're almost
certainly in one of those pure modules, and your test belongs there too.

`NoteEditor` is **uncontrolled**: `initialContent` is read once, and showing
different content goes through the imperative `NoteEditorHandle` (or a remount
via `key`), never a prop change. Edits flow out through `onEditorChange`; the
session pushes content back in through `applyContent` and recognizes the
editor's synchronous re-entrant change event so a programmatic reload is never
mistaken for a user edit.

## The save loop

```text
keystroke → session.editorChanged() → debounce (800ms) → atomic write
  → file watcher event / local-write echo → core reindex
  → the same event returns to the session → recognized as our echo → ignored
```

Saving never calls the indexer from the session: our own write flows through
the same file-change pipeline as any external change. On desktop that signal
comes from the watcher; on mobile, where the app sandbox has no external
writers, the typed write binding emits an in-process local-write echo after
the write lands. On every change event the session re-reads the file and
compares by content: a match against what it last wrote (or a still-settling
in-flight write) is our own echo and is ignored.

Invariants the loop maintains:

- **External changes never clobber a dirty buffer.** A clean buffer reloads
  imperatively; a dirty one parks the external content as a `conflict` for the
  user ("keep mine" rewrites the file, "load theirs" discards the buffer).
- **Writes are generation-pinned.** Every write carries the open graph's
  generation, read at write time rather than captured at session creation.
  Rust rejects stale ones, so a flush racing a graph switch fails loudly
  instead of landing in the wrong graph.
- **Frontmatter belongs to the session, not the editor.** meowdown mangles a
  `---` block, so the session splits every disk read, keeps the exact header
  bytes aside, and rejoins them on every write. The editor only ever sees the
  body; metadata writes go through `session.updateFrontmatter()` without
  disturbing the view.
- **Round-trip fidelity gates editability** (`roundtrip.ts`). Before the save
  pipeline may rewrite a note, the editor must prove it can reproduce it; a
  converter gap (e.g. task lists today) opens the note as a `protected`
  read-only view rather than silently rewriting the file minus what the editor
  couldn't model.

## Drag and drop needs Tauri's native handler off

Every drag interaction in the editor rides the browser's HTML5 drag-and-drop
events, which Tauri's webview swallows by default. The window sets
`dragDropEnabled: false`
([`tauri.conf.json`](../../apps/desktop/src-tauri/tauri.conf.json)); without it,
none of these work:

- **meowdown's block-handle reorder.** The drag handle is a native `draggable`
  element, and meowdown's drop indicator is drawn *only* from a `dragover`
  listener on the editor DOM. No `dragover` means no indicator, and the `drop`
  that commits the move never fires either.
- **Image paste/drop** (`use-image-persistence.ts`) and **chat file drop**
  (`chat-screen.tsx`), both of which read `event.dataTransfer` off HTML5 drop
  events.

Tauri's native drag-drop handler (on by default) registers an OS-level drop
target on the webview so file drops reach Rust. While it is on, it intercepts
`dragstart`/`dragover`/`drop` before the DOM sees them, so the features above
silently do nothing inside the app even though they work in a plain browser
(for example the meowdown dev server). Turning it off costs us Tauri's
`onDragDropEvent` (OS file drops delivered to Rust), which the app does not use:
we handle every drop in the webview with HTML5 events instead.

## Work that outlives a pane

React unmount effects never run on the quit paths (window close, ⌘Q), and some
editor work must survive pane teardown. The pieces to understand are:

- **`document-binding.ts`** — the per-pane lifecycle policy. A rename can move
  the file and retarget the live session before React has rendered the new
  route; the binding lets the next render adopt that same session, preserving
  cursor, selection, undo history, conflict state, and pending writes. If no
  adoption happens, the deferred hand-off tears the session down.
- **`open-documents.ts`** — the app-global registry of live sessions. Quit
  teardown (`flushOpenDocuments`) flushes every buffer and awaits settle-time
  work before the webview dies; the rename coordinator uses `openSession(path)`
  to discover whether a note is open (possibly *reopened* in a new pane) and
  route through its live session instead of racing the disk.
- **`rename-coordinator.ts` + `title-rename.ts` + `move-note.ts`** — the
  auto-rename flow (Plans 07b/17). The tracker watches the session's
  `onContent` stream and fires only on *settled* titles (quiet timer, or a
  settle point: blur/teardown/quit) — never per keystroke, so intermediate
  titles don't spray junk rewrites across the graph. The coordinator
  serializes the graph-wide link rewrite, records the old title as an alias,
  and moves the file onto the new title's slug, reporting progress through the
  global operations store — a rename is app-level background work, not pane
  state.

## File map

| File | Owns |
|---|---|
| `note-session.ts` | save pipeline, conflicts, protection, frontmatter — the rules |
| `document-binding.ts` | create/adopt/teardown/hand-off lifecycle for one pane |
| `use-note-document.ts` | React adapter: session ↔ state/commands/watcher/editor |
| `note-editor.tsx` | meowdown composition + our extensions; imperative handle |
| `roundtrip.ts` | fidelity classification (`exact` / `normalizing` / `lossy`) |
| `open-documents.ts` | app-global live-session registry; quit flush |
| `title-rename.ts` | settled-title detection (pure, timer-driven) |
| `rename-coordinator.ts` | rename lifecycle: rewrite chain + alias placement + file move |
| `move-note.ts` | move a note while carrying/following a live session |
| `wiki-links.ts` | `[[…]]` chips as view decorations over literal text |
| `wiki-autocomplete.tsx` / `-entries.ts` | `[[` popover; pure row assembly |
| `use-wiki-link-navigation.ts` | chip click → resolve → navigate or create |
| `images.ts` / `use-image-persistence.ts` | image widgets; paste/drop → `assets/` |
| `keymap.ts` | central shortcut registry (rejects duplicate bindings) |

## Where new code goes

- **A new save/reload/conflict behavior** → `note-session.ts`, with a direct
  test. If you need React state for it, expose it on the snapshot and let the
  adapter stay dumb.
- **A new editor feature** (decoration, input rule) → its own module composed
  in `note-editor.tsx`. Keep markdown *literal* in the document and render via
  decorations — that's what keeps serialization byte-identical (see
  `wiki-links.ts` for the full rationale). Shortcuts go through `keymap.ts`.
- **Markdown grammar** (what counts as a wiki link, an image, a heading) →
  `packages/core/src/markdown/`, never the editor: the editor and the indexer
  share one grammar so chips and index links can't drift.
- **Pane-level wiring** → a focused hook next to the existing ones, composed
  in `note-pane.tsx`; components stay composition-only. Desktop daily notes
  mount panes through `daily-stream.tsx`; mobile mounts the same `NotePane`
  through `mobile/day-carousel.tsx` and `mobile/screens/note.tsx`, so keep
  note semantics shared and put surface-specific chrome outside the pane.
