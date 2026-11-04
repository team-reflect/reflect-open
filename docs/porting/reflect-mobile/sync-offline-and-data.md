# Porting sync, offline, and the data layer

**v2 status: replaced.** Nothing in V1 mobile's Firestore/Yjs/encrypted-
SQLite stack survives; v2 mobile runs desktop's markdown + libgit2 +
rebuildable-index architecture unchanged
([sync strategy](../../reflect-v2-sync-strategy.md), Plan 19 decisions
5–6). What ports is the set of **behavioral contracts** V1 proved matter on
a phone, with enough V1 mechanism to explain each.

## What V1 mobile does

### The local stack

- SQLite via `@capacitor-community/sqlite` with a `capacitor-sqlite-kysely`
  dialect, one file, **all access serialized through a `pLimit(1)` lock**
  because the Capacitor bridge can't handle concurrency
  (`services/db/sqlite/`).
- Tables mirror the web projection (`services/db/sqlite/schema.ts`):
  `notes` (Yjs state + ProseMirror JSON + derived columns: tags, hasTask,
  emails, linkHrefs, dailyDate, normalizedSubject, aliases, backlinkIds,
  documentText), `notesFts`, `noteBacklinks`, `assets`/`assetsFts`,
  `contacts`, `books`, `commitBackups`, `jobs`, `lastSyncs`, plus an unused
  `notesVec`.
- Note content is **encrypted at rest**, decrypted on-device during
  sync-down with the graph key.

### Sync

Layers in `services/db/sync/` and `services/api/`:

- **Down**: an initial paginated Firestore fetch (500-doc pages, "Got X
  notes" progress), then `onSnapshot` listeners filtered by a per-table
  watermark (`lastSyncs`, 1-hour safety buffer). Remote-newer wins;
  diverged commit histories trigger a fetch-and-replay path.
- **Up**: rows flagged `hasChanges`/`isDeleted` flush on a ~2 s debounce
  and at once on reconnect; Firestore transactions reject writes when the
  remote is newer (retry later). Deletes stay soft locally until the remote
  delete succeeds.
- **Content**: note bodies sync as **Yjs commits** through the shared
  change manager; unsaved edits are pending commits in `ChangeStore` and
  survive reloads. On reconnect they flush and missed remote commits
  replay; CRDT merge means users never see a conflict.
- **Jobs** (`jobs` table): reindex search, rewrite backlinks, repair docs,
  persisted across restarts.
- Sync pauses when the device is nearly full; online state comes from
  `@capacitor/network`.

### What it adds up to (the contracts)

1. **Instant open**: every UI read hits local SQLite.
2. **Everything works offline**: read, search, edit, create; changes
   reconcile later.
3. **Writes are optimistic**: the UI updates at once; persistence and sync
   are background.
4. **Capture is never lost**: pending changes survive reloads, process
   death, and offline periods.
5. **First sync is onboarding**: visible, honest progress.

## What changes in v2, and why

The architecture is decided and largely built; this is the mapping:

- **Markdown files are the source of truth**; SQLite under `.reflect/` is a
  rebuildable per-device projection (desktop's schema and indexing code).
  V1's derived columns survive as the projection; the encrypted dual
  document form does not.
- **libgit2 replaces Firestore**: foreground-only cycles (resume, debounced
  edits, network regain) with plain-language status. No real-time
  listeners; the phone is often "not yet pushed", so status is more
  prominent than on desktop.
- **The no-watcher seam replaces sync-down fan-out**: every local write
  emits its file-change batch in-process (`emitFileChanges`), driving
  incremental reindex, query invalidation, sync dirty-marking, and
  open-editor reconciliation. Pull-applied changes use `onRemoteChanges`.
- **Contract 4 is re-solved locally**: local commit never waits on the
  network; push is opportunistic; **flush-on-background + a local commit on
  pause** protects the save-debounce window even if iOS kills the app
  (Plan 19 decision 6: kill mid-debounce, the edit is on disk).
- **Conflicts merge on the device.** V1's CRDT merged silently. v2 merges
  notes through one ladder (Plan 21); other files keep a conflict copy.
  Conflicts never block other notes. The canonical case, phone + Mac both
  appending to today, merges on the append-union rung.
- **Contract 5 maps to first clone**: cloning a years-old graph over
  cellular, foregrounded, with progress; shallow/partial clone is the
  follow-up.
- **No job queue**: reindex is incremental off the write seam, and a full
  rebuild from files is always possible. **No disk-space machinery** in v1
  (revisit if clone-size complaints arrive). **`chat_*` tables** are
  per-device durable state and never sync, so desktop chat history does not
  appear on mobile.

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
