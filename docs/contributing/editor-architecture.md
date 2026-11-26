# Editor architecture

A map of the editor: the React side in `apps/web/src/editor/` and the
document logic in `packages/core/src/documents/`. The design docs are Plans
05/05b (editor + fidelity), 06 (daily notes), and 07/07b (backlinks, renames).

## The layers

```text
NotePane / DailyStream / MobileNote     components — composition only
  ├─ useNoteSession()                   React adapter (editor/use-note-session.ts)
  │    └─ noteSessions.sessionFor()     the sessions of the graph, one per path (core)
  │         ├─ NoteSession              the document state machine, a `Store` (core)
  │         │    └─ NoteFileService     read / write, injected through `deps`
  │         └─ titleRename.createCoordinator()   the auto-rename flow (core)
  ├─ useWikiLinkNavigation()            [[link]] click → route / create
  ├─ useWikiLinkHoverPreview()          [[link]] hover → passive local preview
  ├─ useAssetPersistence()              paste/drop → assets/ write (AttachmentService)
  └─ <NoteEditor>                       meowdown + our extensions (editor/note-editor.tsx)
```

The load-bearing split is **data vs. view**. A note's text lives in its
session (`packages/core/src/documents/note-session.ts`), which owns every
save/conflict/protection rule as a state machine with no React and no editor:
file access, the clock and the logger come through `deps`. A session is a
`Store` of its snapshot. `NoteSessionService`
(`documents/note-session-service.ts`) holds the sessions, one per path, and
decides how long each lives. A view never creates, loads or destroys a
session: `use-note-session.ts` gets the session of a path and subscribes to
it.

The subscription is the only thing a view contributes to a session's
lifetime. A session with a subscriber is **observed**: it reconciles with the
note file on every write to it.
When the last subscriber leaves (the pane unmounts, a virtual row scrolls
away, a tab switches), the session flushes and its pending title rename
settles, and the session stays: its text, and any edit a failed write left
unsaved, are still there for the next view, which renders them in its first
commit. An unobserved session reads nothing; a file change marks it stale, and
it catches up when it is next observed or committed to. The service keeps a
bounded number of unobserved sessions and disposes the least recently
observed clean ones.

Tests drive the session and the service directly over test doubles
(`note-session.test.ts`, `note-session-service.test.ts`, with
`createTestNoteFileService()` and `createTestClockService()`); if you're
changing *what happens*, you're almost certainly in one of those core modules,
and your test belongs there too.

`NoteEditor` is **uncontrolled**: `initialContent` is read once, from
`session.editorSeed()` when the editor mounts, and showing
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
the same file-change pipeline as any external change. `NoteFileService.write`
reports the write to `FileChangeService`, which echoes it in-process after the
write lands; on desktop the watcher reports it again. On every change event an
observed session re-reads the file and compares by content: a match against
what it last wrote (or a still-settling in-flight write) is our own echo and
is ignored.

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
- **Round-trip fidelity gates editability** (meowdown's `checkRoundTrip`, passed to
  the session as its `classify` option). Before the save
  pipeline may rewrite a note, the editor must prove it can reproduce it; a
  converter gap (e.g. task lists today) opens the note as a `protected`
  read-only view rather than silently rewriting the file minus what the editor
  couldn't model.

## Drag and drop needs Tauri's native handler off

Every drag interaction in the editor rides the browser's HTML5 drag-and-drop
events, which Tauri's webview swallows by default. The window sets
`dragDropEnabled: false`
([`tauri.conf.json`](../../apps/tauri/tauri.conf.json)); without it,
none of these work:

- **meowdown's block-handle reorder.** The drag handle is a native `draggable`
  element, and meowdown's drop indicator is drawn *only* from a `dragover`
  listener on the editor DOM. No `dragover` means no indicator, and the `drop`
  that commits the move never fires either.
- **Image paste/drop** (`use-asset-persistence.ts`) and **chat file drop**
  (`chat-screen.tsx`), both of which read `event.dataTransfer` off HTML5 drop
  events.

Tauri's native handler (on by default) registers an OS-level drop target so
file drops reach Rust, and it intercepts `dragstart`/`dragover`/`drop` before
the DOM sees them. The features above then silently do nothing in the app,
though they work in a plain browser (e.g. the meowdown dev server). Turning it
off costs `onDragDropEvent`, which the app does not use: every drop is handled
in the webview.

## Work that outlives a pane

React unmount effects never run on the quit paths (window close, ⌘Q), and
saves and renames must finish with no pane mounted. The pieces to understand
are all core services (`packages/core/src/documents/`):

- **`NoteSessionService`** (`note-session-service.ts`,
  `CoreServices.noteSessions`) — the sessions of this webview's graph. Quit
  teardown flushes every buffer and awaits settle-time work before the webview
  dies: `PersistenceFlushService` calls `noteSessions.flushAll()` as its
  `documents` flusher. A rename moves the session with the file
  (`moveSession`), so the pane keeps the same session, with cursor, selection,
  undo history, conflict state, and pending writes. A graph switch or close
  flushes and drops every session (`releaseAll`).
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
  tasks, previews): the note's session when it has one, after the session has
  caught up with the file, and the disk otherwise. It never creates a session:
  a bulk edit (a rename's link rewrite) must not load a session per note.

## File map

Core, `packages/core/src/documents/`:

| File | Owns |
|---|---|
| `note-session.ts` (+ `note-session-types.ts`) | `NoteSession`: save pipeline, conflicts, protection, frontmatter — the rules |
| `note-session-service.ts` | `NoteSessionService`: one session per path, observation, staleness, eviction; `flushAll` for quit |
| `note-document-service.ts` | session content, else generation-pinned disk read; session-aware writes |
| `note-move-service.ts` | move a note while carrying/following a live session; `onMoved` |
| `title-rename-service.ts`, `title-rename-tracker.ts` | settled-title detection and the rename pipeline |
| `attachment-service.ts` | the attachment catalog, asset saves, image URLs |

App, `packages/app/src/`:

| File | Owns |
|---|---|
| `search/autocomplete-suggestion-service.ts`, `search/wiki-autocomplete-entries.ts` | the `[[` and `#` menus' data; pure row builders |
| `navigation/link-navigation-service.ts` | what a clicked wiki link, Markdown link or deep link does |
| `commands/keymap-service.ts` | the shortcut registry (rejects duplicate bindings) |

Desktop, `apps/web/src/editor/`:

| File | Owns |
|---|---|
| `use-note-session.ts` | React adapter: the session of a path and its snapshot |
| `note-editor.tsx` | meowdown composition + our extensions; imperative handle |
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
