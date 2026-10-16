# Editor architecture

A map of the editor for contributors: the React side in
`apps/desktop/src/editor/` and the document logic in
`packages/core/src/documents/`. The design docs are Plans 05/05b (editor +
fidelity), 06 (daily notes), and 07/07b (backlinks, renames); this is the
orientation layer those plans don't give you.

## The layers

```text
NotePane / DailyStream / MobileNote     components — composition only
  ├─ useNoteDocument()                  React adapter (editor/use-note-document.ts)
  │    ├─ createDocumentBinding()       create/adopt/teardown/hand-off policy (core)
  │    ├─ noteSessions.create()         the document state machine, `NoteSession` (core)
  │    │    └─ NoteFileService          read / write, injected through `deps`
  │    └─ titleRename.createCoordinator()   the auto-rename flow (core)
  ├─ useWikiLinkNavigation()            [[link]] click → route / create
  ├─ useWikiLinkHoverPreview()          [[link]] hover → passive local preview
  ├─ useAssetPersistence()              paste/drop → assets/ write (AttachmentService)
  └─ <NoteEditor>                       meowdown + our extensions (editor/note-editor.tsx)
```

The load-bearing split is **session vs. adapter**. The session
(`packages/core/src/documents/note-session-service.ts`, built by `NoteSessionService`)
owns every save/conflict/protection rule as a state machine with no React and
no editor: file access, the clock and the logger come through the service's
`deps`. `use-note-document.ts` only wires it to React state, the watcher
stream, and the editor's imperative handle; it gets `noteSessions`,
`openDocuments` and `titleRename` from `useCoreServices()`.
`documents/document-binding.ts` owns the pane lifecycle around that session:
create, adopt after a rename-following route change, teardown, and the
microtask hand-off when a moved note is not adopted. Tests drive the session
and binding directly over test doubles (`note-session.test.ts`,
`document-binding.test.ts`, with `createTestNoteFileService()` and
`createTestClockService()`); if you're changing *what happens*, you're almost
certainly in one of those core modules, and your test belongs there too.

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
writers, `NoteFileService.write` reports the write to `FileChangeService`,
which echoes it in-process after the write lands. On every change event the session re-reads the file and
compares by content: a match against what it last wrote (or a still-settling
in-flight write) is our own echo and is ignored.

Invariants the loop maintains:

- **External changes never clobber a dirty buffer.** A clean buffer reloads
  imperatively. A dirty one saves at once, the write merges with the newer
  disk text through the conflict ladder, and the session adopts the result.
- **Writes are generation-pinned.** Every write carries the generation of the
  graph the session was opened on, read at write time so a reopen of that
  graph carries over. Rust rejects stale ones, so a flush racing a graph
  switch fails loudly instead of landing in the wrong graph.
- **Frontmatter belongs to the session, not the editor.** meowdown mangles a
  `---` block, so the session splits every disk read, keeps the exact header
  bytes aside, and rejoins them on every write. The editor only ever sees the
  body; metadata writes go through `session.updateFrontmatter()` without
  disturbing the view.
- **Round-trip fidelity gates editability** (`editor/roundtrip.ts`, passed to
  the session as its `classify` option). Before the save
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
- **Image paste/drop** (`use-asset-persistence.ts`) and **chat file drop**
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
editor work must survive pane teardown. The pieces to understand are all core
services (`packages/core/src/documents/`):

- **`document-binding.ts`** — the per-pane lifecycle policy. A rename can move
  the file and retarget the live session before React has rendered the new
  route; the binding lets the next render adopt that same session, preserving
  cursor, selection, undo history, conflict state, and pending writes. If no
  adoption happens, the deferred hand-off tears the session down.
- **`OpenDocumentsService`** (`open-documents-service.ts`,
  `CoreServices.openDocuments`) — the registry of live sessions of this
  webview. Quit teardown flushes every buffer and awaits settle-time work
  before the webview dies: `PersistenceFlushService` calls
  `openDocuments.flushAll()` as its `documents` flusher. The
  rename and move services use `sessionFor(path)` to discover whether a note
  is open (possibly *reopened* in a new pane) and route through its live
  session instead of racing the disk.
- **`TitleRenameService` + `NoteMoveService`** (`title-rename-service.ts`,
  `title-rename-tracker.ts`, `note-move-service.ts`) — the auto-rename flow
  (Plans 07b/17). The tracker watches the session's `onContent` stream and
  fires only on *settled* titles (quiet timer, or a settle point:
  blur/teardown/quit) — never per keystroke, so intermediate titles don't
  spray junk rewrites across the graph. The coordinator serializes the
  graph-wide link rewrite, records the old title as an alias, and moves the
  file onto the new title's slug, reporting progress through
  `ProgressPort` — a rename is app-level background work, not pane state.
  `NoteMoveService.onMoved` announces a landed move; the router subscribes and
  rewrites its history.
- **`NoteDocumentService`** (`note-document-service.ts`) — session-aware reads
  and writes for everything that is not the pane itself (frontmatter commits,
  tasks, previews): the live session's buffer when the note is open, the disk
  otherwise.

## File map

Core, `packages/core/src/documents/`:

| File | Owns |
|---|---|
| `note-session-service.ts` (+ `note-session-types.ts`) | `NoteSessionService`: save pipeline, conflicts, protection, frontmatter — the rules |
| `document-binding.ts` | create/adopt/teardown/hand-off lifecycle for one pane |
| `open-documents-service.ts` | the live-session registry; `flushAll` for quit |
| `note-document-service.ts` | live open-session content, else generation-pinned disk read; session-aware writes |
| `note-move-service.ts` | move a note while carrying/following a live session; `onMoved` |
| `title-rename-service.ts`, `title-rename-tracker.ts` | settled-title detection and the rename pipeline |
| `attachment-service.ts` | the attachment catalog, asset saves, image URLs |

Core, elsewhere:

| File | Owns |
|---|---|
| `packages/app/src/search/autocomplete-suggestion-service.ts`, `packages/app/src/search/wiki-autocomplete-entries.ts` | the `[[` and `#` menus' data; pure row builders |
| `packages/app/src/navigation/link-navigation-service.ts` | what a clicked wiki link, Markdown link or deep link does |
| `packages/app/src/commands/keymap-service.ts` | the shortcut registry (rejects duplicate bindings) |

Desktop, `apps/desktop/src/editor/`:

| File | Owns |
|---|---|
| `use-note-document.ts` | React adapter: session ↔ state/watcher/editor |
| `note-editor.tsx` | meowdown composition + our extensions; imperative handle |
| `roundtrip.ts` | fidelity classification (`exact` / `normalizing` / `lossy`), re-exported from meowdown |
| `use-editor-autocomplete.ts` | `[[` and `#` search handlers over `AutocompleteSuggestionService` |
| `use-wiki-link-navigation.ts`, `use-tag-navigation.ts` | chip click → resolve → navigate or create |
| `use-wiki-link-hover-preview.tsx` | desktop chip hover → side-effect-free local preview renderer |
| `use-asset-persistence.ts`, `use-note-attachments.ts` | paste/drop → `assets/`; how images and attachment links render |
| `keymap.ts` | the editor-scope shortcut table, registered in `KeymapService` at boot (`lib/shortcuts.ts`) |

## Where new code goes

- **A new save/reload/conflict behavior** → core's `documents/note-session-service.ts`,
  with a direct test. If you need React state for it, expose it on the
  snapshot and let the adapter stay dumb.
- **Logic that reads or writes notes for an editor feature** (a preview, a
  suggestion source, an action on the open note) → the core service that owns
  the domain, or a new one ([services.md](services.md)). The hook in
  `editor/` reads it with `useCoreServices()` and stays thin.
- **A new editor feature** (decoration, input rule) → its own module composed
  in `note-editor.tsx`, or upstream in meowdown. Keep markdown *literal* in the
  document and render via decorations — that's what keeps serialization
  byte-identical. Shortcuts go through `keymap.ts`.
- **Markdown grammar** (what counts as a wiki link, an image, a heading) →
  `packages/core/src/markdown/`, never the editor: the editor and the indexer
  share one grammar so chips and index links can't drift.
- **Pane-level wiring** → a focused hook next to the existing ones, composed
  in `note-pane.tsx`; components stay composition-only. Desktop daily notes
  mount panes through `daily-stream.tsx`; mobile mounts the same `NotePane`
  through `mobile/day-slide.tsx` and `mobile/screens/note.tsx`, so keep
  note semantics shared and put surface-specific chrome outside the pane.
