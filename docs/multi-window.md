# Multiple windows & cross-window communication

Modifier-click a note reference anywhere it appears in the app — editor
`[[wiki links]]`, backlinks, pinned notes, calendar days, search/palette
results, and other note lists — or run the selected-note command, and the note
opens in its own chrome-free window: just the editor with its backlinks, no
sidebar, palette, or context panel. In-note `reflect://` links follow the same
convention. This document describes how those windows relate to the main
window and to each other.

Two ideas carry the whole design:

1. **Adoption, never re-open.** Rust's session states (`GraphState`,
   `IndexState`) are app-wide singletons whose generations bump on every
   open, invalidating everything pinned to the previous session. A secondary
   window therefore never runs `graph_open`/`index_open`; it *adopts* the
   main window's live sessions through a pure read (`window_bootstrap`).
2. **User actions work in any window; app-wide singletons run only in
   main.** Editing, recording an audio memo, chatting — all fine anywhere.
   Background machinery that must exist exactly once — sync, the capture
   drain, the indexer, AI reconcilers — belongs to the main window, and a
   note-window edit reaches that machinery the same way an external edit
   does: through the file watcher.

## Window roles

The webview's Tauri label decides the role: `main` is the config-declared
window; note windows get content-addressed `note-<hash(deep link)>` labels
(so reopening a target finds its window). The frontend reads the role
via `isMainWindow()` (`src/lib/windows/window-role.ts`), which treats
bridge-less environments — browser dev, jsdom, the `?platform=ios` harness —
as main: they are all single-window.

| Runs where?          | main window | note window |
| -------------------- | ----------- | ----------- |
| Editing, note sessions, quit flush of own buffers | ✓ | ✓ |
| Chat UI, audio recording, palette-free routed views | ✓ | ✓ |
| Index writer (reconcile → subscribe → watch)      | ✓ | — |
| Git backup + iCloud controllers                   | ✓ | — |
| Capture drain, transcription, embeddings, asset describing | ✓ | — |
| Update checks, OS deep-link intake                | ✓ | — |
| Graph management (open / switch / delete)         | ✓ | refused |

The gate is structural: singleton mounts go through `useMainWindowEffect`
(`src/hooks/use-main-window-effect.ts`), so a new background controller
declares its ownership rather than remembering a guard. Graph-mutating
actions are refused off-main in `GraphProvider` (`requireMainWindow`) —
opening a graph from a note window would re-root the shared `GraphState`
under every window at once.

## Opening a window

The main workspace also exposes `note.openInNewWindow` at Cmd/Ctrl+Shift+O.
It targets `CommandContext.notePath()`, so the focused day in the daily stream
and an ordinary routed note both open through the same mechanism described
below. The command is also exposed in the native Window menu.

1. A modifier click (`isNewWindowClick` — **mouse events only**: meowdown
   also fires link handlers for Mod-Enter keyboard follows, whose modifier
   is held by definition) resolves the target as usual. Resolved note
   references share `useNoteLinkNavigation`, which applies the convention and
   delegates to `openRouteInNewWindow`; raw in-note links use
   `openDeepLinkInNewWindow` (`src/lib/windows/open-in-new-window.ts`). Routes
   serialize through the existing deep-link grammar (`deepLinkForRoute`);
   capture links (`append`, `task`) are writes, not places, and never
   window-ify. Any declined or failed open falls back to in-window navigation,
   so the modifier can never make a link do nothing.
2. `open_note_window` (`src-tauri/src/windows.rs`) refuses without an open
   graph or while a quit is in flight, dedupes by label (see
   [Focus & re-navigation](#focus--re-navigation)), stores the deep link in
   a label-keyed pending map (`WindowInit`), and builds the window — cascade
   offset by the live note-window count, main-window chrome (overlay
   titlebar, native drag-drop off), excluded from window-state tracking.
3. The new webview boots the ordinary desktop tree. `GraphProvider` sees a
   non-main label and takes the adoption leg (`useNoteWindowBoot`):
   `window_bootstrap` returns the graph info + index generation (unbumped —
   pinned by the `session_adoption_reads_never_bump_generations` test) and
   drains the pending deep link. Because ⌘-click builds **path-shaped**
   links, the route usually derives synchronously
   (`initialRouteForDeepLink`) and seeds the router directly — the window's
   first workspace render is already the clicked note, no flash of today's
   daily note. Only a target that needs the index (an id/title-shaped link)
   rides the normal deep-link intake, buffering until the workspace's
   `DeepLinkProvider` attaches — the same path an OS-delivered `reflect://`
   URL takes, including `openNote` resolution and error surfacing.
4. The window renders `NoteWindowContent`: the routed view only, with daily
   targets shown as a single lazy `NotePane` (a daily is treated like any
   other note here, day label standing in for the title). The OS window
   title follows the shown note (`useNoteWindowTitle`).

A bootstrap failure (racing a graph switch) parks the window on an error
screen — never the chooser, which could re-root every other window.

## How windows communicate

All cross-window signals are **Tauri events emitted from Rust**; the
frontends never talk to each other directly. In-process signals
(`emitIndexApplied`, `emitNoteMoved`) do not cross webviews — that
asymmetry is what each broadcast below exists to bridge.

| Event | Emitted by | Consumed by | Purpose |
| ----- | ---------- | ----------- | ------- |
| `index:changed` | file watcher (`watcher.rs`) | every window | Open editors reconcile external changes; the main window's indexer applies the batch. Pre-dates multi-window; note windows get editor freshness from it for free. |
| `index:written` | index write commands after a **committed** write (`db/mod.rs`) | note windows only | Refetch index-backed queries (backlinks, lists). The main window invalidates in-process via its indexer and must not subscribe — it would refetch twice. |
| `note:moved` | `note_move_indexed` / `index_move` after rows commit | **every** window (`desktop-root.tsx`) | Retarget open sessions + router history after a rename. Renames can originate in any window (a title edit), and a window left behind would resurrect the dead path on its next save. The origin window's in-process handling makes the echo idempotent. |
| `window:navigate` | `open_note_window` on a dedupe hit (targeted `emit_to`) | that note window | Reopening a target focuses its window *and* re-navigates it there — it may have browsed elsewhere since opening. |
| `app:quit-requested` | the run loop on a deferred ⌘Q (`lib.rs`) | every window | Each window flushes its own dirty buffers, then confirms. |

The write path that ties it together: a note window saves via the ordinary
generation-pinned `note_write` → the watcher reports the file → the main
window indexes it → `index:written` broadcasts → other note windows refetch.
A note-window edit is indistinguishable from an external edit by design; no
new sync or indexing paths exist.

### Deep-link intake scoping

The intake module (`src/lib/deep-links/intake.ts`) is per-webview state.
Every window attaches a handler (in-note `reflect://` clicks must work
everywhere), but only the main window starts the **OS** listener — the
plugin's event stream reaches every webview, and N windows must not all
navigate on one OS-delivered URL. Handler staleness is scoped to the *graph
session* (generation), not the effect lifetime: StrictMode's probe cycle
detaches/reattaches around in-flight resolutions, and an effect-scoped flag
silently dropped the note window's initial link.

## Quit & close

- **Window close (⌘W / red button):** each webview's `onCloseRequested`
  flushes its own note buffers and settings; the backup commit hook is only
  registered in main. Per-window JS state makes this correct with no
  coordination.
- **Closing the main window closes every note window.** Note windows adopt
  main's graph session and would degrade silently without it — edits still
  land on disk, but nothing indexes, syncs, or propagates renames. Rather
  than run in that half-alive state, they close with their owner (via
  `close()`, so each child's flush runs exactly like ⌘W — no data loss).
- **Switching or deleting the graph closes note windows first.** They
  adopted the outgoing session, so `GraphProvider` awaits
  `close_note_windows` **before** anything bumps the generations: each
  child's flush runs against the still-valid session, and a destroyed
  webview implies its flush landed (close-requested defers destruction until
  the handler resolves). Bump-first ordering would reject their final saves
  as stale. The wait is bounded — a wedged child can't block the switch.
- **App quit (⌘Q):** the run loop defers the exit, arms `QuitState` with the
  **labels** of every live webview, and emits `app:quit-requested`. Every
  window flushes and calls `quit_confirm`; settling the *last owed label*
  exits. Labels, not a counter: a window that confirms and is then
  destroyed — or re-confirms after a second ⌘Q — must count once, never
  spending another window's obligation while it is still mid-flush. A window
  destroyed mid-handshake settles its own label so survivors can't hang, and
  `open_note_window` refuses while armed so no webview is born outside the
  pending set.

## SQLite & contention

All windows in one process share the single Rust index connection — there is
no per-window database state, so multi-window adds no lock contention. A
*second process* on the same graph (another app flavor, the `reflect` CLI)
can contend; the writer connection carries a 5s `busy_timeout`
(`crates/index-schema`) so cross-process locks wait instead of failing with
`database is locked`.

## Deliberate v1 limits

- Note windows are **same-graph only**; switching graphs lives in main.
- Note windows close with the main window (above) — "promote a note window
  to session owner", which would let one survive as a focus surface, is the
  eventual alternative if that usage ever matters.
- The same note open in two windows converges through the existing
  external-change reconciliation, the same path an iCloud edit takes.
- The native macOS application menu is installed by the main window only.
  Menu action channels belong to the webview that creates them; letting a
  chrome-free note window replace the app-wide menu would leave command items
  with no `useAppShortcuts` dispatcher.
- A note window's settings screen shows sync as loading (its controller is
  deliberately inert).
- **Settings are effectively main-window-owned.** Note windows mount no
  settings-writing surface (no sidebar/palette/shortcuts/settings route),
  so their quit-time `flushSettings` is a comparison no-op — the provider
  only writes when the window's own doc diverged from its confirmed
  baseline. Constraint for future work: settings saves are full-document,
  so before any surface lets a note window call `updateSettings`, add a
  `settings:changed` broadcast (à la `index:written`) or a stale-base save
  would revert other windows' changes.
