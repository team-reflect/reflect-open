# Multiple windows & cross-window communication

Modifier-click a note reference anywhere in the app (editor `[[wiki links]]`,
backlinks, pinned notes, calendar days, search/palette results, other note
lists), or run the selected-note command, and the note opens in its own
chrome-free window: the editor with its backlinks, no sidebar, palette, or
context panel. In-note `reflect://` links follow the same convention.

Two ideas carry the design:

1. **Adoption, never re-open.** Rust's session states (`GraphState`,
   `IndexState`) are app-wide singletons whose generations bump on every
   open, invalidating everything pinned to the previous session. So a
   secondary window never runs `graph_open`/`index_open`; it *adopts* the main
   window's live sessions through a pure read (`window_bootstrap`).
2. **User actions work in any window; app-wide singletons run only in
   main.** Editing, audio memos, and chat work anywhere. Machinery that must
   exist once (sync, the capture drain, the indexer, AI reconcilers) belongs to
   main, and a note-window edit reaches it the way an external edit does:
   through the file watcher.

## Window roles

The Tauri label decides the role: `main` is the config-declared window; note
windows get content-addressed `note-<hash(deep link)>` labels, with a numeric
suffix when a distinct destination is needed. Environments without native
windows (browser dev, tests, the `?platform=ios` harness) are single-window and
labelled `main`.

| Runs where?          | main window | note window |
| -------------------- | ----------- | ----------- |
| Editing, note sessions, quit flush of own buffers | ✓ | ✓ |
| Chat UI, audio recording, palette-free routed views | ✓ | ✓ |
| Index writer (reconcile → subscribe → watch)      | ✓ | — |
| Git backup + iCloud sync services                 | ✓ | — |
| Capture drain, transcription, embeddings, asset describing | ✓ | — |
| Update checks, OS deep-link intake                | ✓ | — |
| Graph management (open / switch / delete)         | ✓ | refused |

The gate is structural: `createAppGraphServices` (`@reflect/app`) starts the
per-graph background lifecycles only for main, so a new lifecycle declares its
ownership instead of remembering a guard. Graph-mutating actions are refused
off-main because opening a graph from a note window would re-root the shared
`GraphState` under every window at once.

## Opening a window

Triggers: a mod-click (Cmd on Apple, Ctrl elsewhere), Mod+Enter on a selected
link or a highlighted palette result, or `note.openInNewWindow`
(Cmd/Ctrl+Shift+O, also in the native Window menu). Each UI boundary turns its
gesture into an explicit `openInNewWindow` flag, and meowdown's `isModEvent`
backs them all. Navigation goes through `LinkNavigationService`
(`packages/app/src/navigation/link-navigation-service.ts`).

- Routes serialize through the deep-link grammar. Capture links (`append`,
  `task`) are writes, not places, and never open a window.
- A declined or failed open falls back to in-window navigation, unless a newer
  navigation has happened, so a late fallback never pulls the source window
  somewhere stale.
- `open_note_window` (`src-tauri/src/windows.rs`) refuses without an open
  graph, after a graph switch, or during a quit. An app-wide gate serializes
  target selection and Tauri's non-atomic window build.
- Reopening a target focuses its preferred window. The invoking window is never
  a destination: if it was preferred, a new suffixed window is created and
  becomes preferred, so modifier-open never redirects its source.
- ⌘-click builds **path-shaped** links, so the route usually derives
  synchronously and the window's first render is already the clicked note, with
  no flash of today's daily. Only id/title-shaped links wait for the normal
  deep-link intake.
- A bootstrap failure (racing a graph switch) parks the window on an error
  screen, never the chooser, which could re-root every other window.

## How windows communicate

All cross-window signals are **Tauri events emitted from Rust**; frontends never
talk directly. In-process signals (`IndexLifecycleService.onApplied`,
`NoteMoveService.onMoved`) do not cross webviews, and each broadcast below
bridges that gap.

| Event | Consumed by | Purpose |
| ----- | ----------- | ------- |
| `index:changed` | every window | Open editors reconcile external changes; main's indexer applies the batch. Note windows get editor freshness from it for free. |
| `index:written` | note windows only | Refetch index-backed queries after a **committed** write. Main invalidates in-process and must not subscribe, or it would refetch twice. |
| `note:moved` | **every** window | Retarget sessions and router history after a rename. A rename can start in any window, and a window left behind would resurrect the dead path on its next save. |
| `window:navigate` | the target note window | Reopening a target re-navigates its window, which may have browsed elsewhere. |
| `app:quit-requested` | every window | Each window flushes its own dirty buffers, then confirms. |

A note window saves via the ordinary `note_write`, the watcher reports the file,
main indexes it, and `index:written` tells other note windows to refetch. A
note-window edit is indistinguishable from an external edit by design; no new
sync or indexing paths exist.

Deep-link intake is per-webview. Every window handles in-note `reflect://`
clicks, but only main starts the **OS** listener: the plugin's stream reaches
every webview, and N windows must not all navigate on one URL. Handler
staleness is scoped to the graph session, not the effect lifetime: StrictMode's
detach/reattach cycle made an effect-scoped flag drop the note window's initial
link.

## Quit & close

- **Window close (⌘W / red button):** each webview flushes its own buffers and
  settings; the backup commit hook lives only in main. On macOS, main hides
  instead of closing, so closing the last window leaves Reflect running like a
  native Mac app.
- **Destroying main closes every note window** (a fallback for shell-driven
  teardown). Without main, note windows would degrade silently: edits land on
  disk, but nothing indexes, syncs, or propagates renames. They close via
  `close()`, so each flush runs as on ⌘W.
- **Switching or deleting the graph closes note windows first**, before
  anything bumps the generations, so their final saves run against the
  still-valid session. Bump-first ordering would reject them as stale. The wait
  is bounded, so a wedged child can't block the switch.
- **App quit (⌘Q):** the run loop defers the exit, records the **labels** of
  every live webview, and emits `app:quit-requested`. The app exits when the
  last owed label confirms. Labels, not a counter: a window that confirms and
  is then destroyed, or confirms twice after a second ⌘Q, must count once. A
  window destroyed mid-handshake settles its own label so survivors can't
  hang, and `open_note_window` refuses during the handshake so no webview is
  born outside the pending set.

## SQLite & contention

All windows share the single Rust index connection, so multi-window adds no lock
contention. A *second process* on the same graph (the `reflect` CLI) can contend;
the writer's 5s `busy_timeout` (`crates/index-schema`) makes it wait instead of
failing with `database is locked`.

## Deliberate v1 limits

- Note windows are **same-graph only**.
- Note windows close with main. "Promote a note window to session owner" is the
  alternative if a surviving focus window ever matters.
- The same note in two windows converges through external-change
  reconciliation, the same path an iCloud edit takes.
- Only main installs the native macOS menu. Menu action channels belong to the
  webview that creates them, so a note window's menu would have no
  `useAppShortcuts` dispatcher.
- A note window's settings screen shows sync as loading (it creates no backup
  service, on purpose).
- **Settings are main-window-owned.** Note windows mount no settings-writing
  surface, so their quit-time flush writes nothing. Settings saves are
  full-document: before any surface lets a note window call `updateSettings`,
  add a `settings:changed` broadcast, or a stale-base save would revert other
  windows' changes.
