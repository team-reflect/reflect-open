# Porting sync, offline, and the data layer

**v2 status: replaced.** Nothing in V1 mobile's Firestore/Yjs/encrypted-
SQLite stack survives — v2 mobile runs the same markdown + libgit2 +
rebuildable-index architecture as desktop, unchanged
([sync strategy](../../reflect-v2-sync-strategy.md), Plan 19 decisions
5–6). What ports is the set of **behavioral contracts** V1 proved matter
on a phone. This doc records those, and enough of the V1 mechanism to
explain where each contract came from.

## What V1 mobile does

### The local stack

- SQLite via `@capacitor-community/sqlite` with a `capacitor-sqlite-kysely`
  dialect; one database file; **all access serialized through a
  `pLimit(1)` lock** because the Capacitor bridge cannot tolerate
  concurrent access (`services/db/sqlite/`).
- Tables mirror the web projection (`services/db/sqlite/schema.ts`):
  `notes` (Yjs update state + ProseMirror JSON + derived columns: tags,
  hasTask, emails, linkHrefs, dailyDate, normalizedSubject, aliases,
  backlinkIds, documentText), `notesFts`, `noteBacklinks`,
  `assets`/`assetsFts`, `contacts`, `books`, `commitBackups`, `jobs`,
  `lastSyncs` — plus a `notesVec` table that exists but is unused.
- All note content is **encrypted at rest**; decryption happens on-device
  during sync-down conversion, gated by the graph encryption key.

### Sync

Several distinct layers (`services/db/sync/`, `services/api/`):

- **Down**: initial paginated Firestore fetch (500-doc pages with "Got X
  notes" progress), then `onSnapshot` listeners filtered by a per-table
  watermark (`lastSyncs`, with a 1-hour safety buffer). Conflicts decided
  by timestamp (remote newer wins); notes whose commit history diverged
  trigger a custom path that fetches and replays commits.
- **Up**: rows flagged `hasChanges`/`isDeleted`, flushed on a ~2 s
  debounce and immediately on reconnect; Firestore transactions reject
  the write if the remote is newer (retry later). Deletes are soft
  locally until the remote delete succeeds.
- **Content**: rich note bodies sync as **Yjs commits** through the
  shared change manager; unsaved local edits live as pending commits in
  `ChangeStore` and persist across reloads. On reconnect, pending commits
  flush and missed remote commits replay — CRDT merge means users never
  see a conflict.
- **Jobs** (`jobs` table): reindex search, rewrite backlinks, repair
  outdated docs — persisted so background work survives restarts.
- The app monitors free disk space and pauses sync when the device is
  nearly full; online state comes from `@capacitor/network`.

### What it adds up to (the contracts)

1. **Instant open**: every UI read hits local SQLite; nothing waits on
   the network.
2. **Everything works offline**: reading, searching, editing, creating —
   changes queue and reconcile later.
3. **Writes are optimistic**: the UI reflects an edit immediately;
   persistence and sync are background concerns.
4. **Capture is never lost**: pending changes survive reloads, process
   death, and offline periods.
5. **First sync is onboarding**: a visible, honest progress experience.

## What changes in v2, and why

The architecture is already decided and largely built; the point of this
section is the mapping, not a proposal:

- **Markdown files are the source of truth**; SQLite under `.reflect/` is
  a rebuildable per-device projection (same schema as desktop, FTS5,
  built by the same indexing code). V1's derived-columns idea survives as
  the index projection; the encrypted dual document representation does
  not.
- **libgit2 replaces Firestore**: foreground-only sync cycles (resume,
  debounced edits, network regain), plain-language status. There are no
  real-time listeners; the phone spends much of its life "not yet
  pushed", which is why the status surface is more prominent than on
  desktop.
- **The no-watcher seam replaces sync-down fan-out**: every local write
  emits its file-change batch in-process (`emitFileChanges`), driving
  incremental reindex, query invalidation, sync dirty-marking, and
  open-editor reconciliation — one channel instead of V1's
  listener/watermark machinery. Pull-applied changes flow through the
  existing `onRemoteChanges` path.
- **Contract 4 is re-solved locally**: local commit never blocks on the
  network; push is opportunistic; **flush-on-background + a local commit
  on pause** protects the save-debounce window even if iOS kills the app
  (Plan 19 decision 6 and its acceptance criterion: kill the app
  mid-debounce, the edit is on disk).
- **Conflicts merge on the device.** V1's CRDT silently merged concurrent
  edits. Reflect v2 merges notes through one ladder (Plan 21), and other
  files keep a conflict copy. Conflicts never block sync of other notes. The canonical case is phone + Mac both appending
  to today's daily note; the append-union rung merges it.
- **Contract 5 maps to first clone**: cloning a years-old graph over
  cellular, foregrounded, with progress UI; shallow/partial clone is the
  noted follow-up.
- **No job queue**: reindex is incremental off the write seam, and a full
  rebuild is always possible from files. **No disk-space machinery** in
  v1 (worth revisiting if clone-size complaints arrive). **Chat tables**
  (`chat_*`) are per-device durable state and never sync — desktop chat
  history does not appear on mobile.

## V1 → v2 mapping

| V1                                             | v2                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Encrypted SQLite as canonical local store      | Markdown files canonical; SQLite a rebuildable projection            |
| Firestore listeners + watermark sync           | Foreground libgit2 cycles (resume / post-edit / network regain)      |
| Yjs commits + pending commits + CRDT merge     | Atomic file saves + git commits; conflicts contained, not merged     |
| `pLimit(1)` DB serialization                   | Gone (rusqlite below the webview)                                    |
| Jobs table (reindex, repair)                   | In-process write seam + rebuildable index                            |
| Initial sync progress UI                       | Clone/initial-index progress in onboarding                           |
| Disk-space pause                               | Not in v1; revisit with large-graph feedback                         |
| Derived note columns for search/filters        | The index projection (same idea, markdown-derived)                   |
