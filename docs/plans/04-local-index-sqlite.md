# Plan 04 — Local Index (SQLite)

**Goal:** Build the rebuildable SQLite projection over the markdown graph (metadata,
links/backlinks, tags, aliases, plain text, FTS), kept fresh by file watching and fully
reconstructable from files.

**Depends on:** Plan 02 (file IO), Plan 03 (extraction output).
**Unlocks:** Plans 06, 07, 08, 09, 10, 14.

**Libraries:** `rusqlite` (bundled, FTS5), `notify` + `notify-debouncer-full`, `blake3`
(Rust); `kysely` (TS). See [Libraries](libraries.md).

## Scope

**In:** where SQLite runs, Kysely wiring, schema, FTS5, indexing pipeline, file watching,
incremental + full rebuild, repair, schema versioning.
**Out:** embeddings (Plan 09), sync state tables (Plan 12), query UX (Plan 08).

## Key decision: SQLite runs in Rust, Kysely builds the SQL

The repo mandates **Kysely**, but FTS5 and `sqlite-vec` must load as native extensions,
which is only practical in Rust, not the WebView. So:

- **SQLite lives in Rust** (bundled `rusqlite`), at `<graph>/.reflect/index.sqlite`.
- **The frontend uses Kysely only as a typed query builder**: a small custom dialect
  compiles queries to `{ sql, params }` and sends them over a Tauri command to Rust.
- Types stay end-to-end, while extensions, migrations, and write transactions stay in Rust.
- **Homes** (per [Architecture & Conventions](architecture-conventions.md)): schema + IPC
  dialect in `@reflect/db`; getters in `@reflect/core` actions. Full Kysely discipline
  (`Selectable/Insertable/Updateable` in signatures, `json()` for JSON columns, camelCase
  at the boundary). The schema lives in `packages/db/src/schema.ts`.

### Alternative rejected: `wa-sqlite` (client-side WASM)

V1 used `wa-sqlite` (WASM SQLite that Reflect sponsored) with IndexedDB/OPFS. That fit
**V1's constraint: a browser app with no native process.** Tauri removes the constraint.
Rejected chiefly on **file permissions**:

- **The index must be a real file beside the notes**, inside the graph, deleted with it,
  and readable by the CLI (Plan 14). WebView `wa-sqlite` persists inside the WebView
  sandbox, not at a known path, which breaks the `.reflect/` model and the CLI.
- **macOS folder access is native.** Security-scoped bookmarks + FS entitlements are held
  only by the native process; JS sees only what Rust hands it.
- **Cross-process locking** (app + read-only CLI) needs POSIX locks + WAL on the real
  file; the OPFS VFS locking cannot coordinate with another process.
- **A Rust-backed VFS** to write the real file would put Rust in the data path anyway,
  with *worse* latency.
- **Extensions + perf:** a custom WASM build with FTS5/`sqlite-vec` is extra pipeline and
  slower on large graphs; embeddings already run in Rust.

The only gain (no per-query IPC) does not outweigh this. Revisit only for a pure-web build.

> **Sub-decision, DECIDED: the index lives inside the graph** (`.reflect/`, gitignored),
> so the graph is self-contained and the CLI can find it. This needs write access to the
> graph folder, which Rust holds. An app-data-dir index (`~/Library/Application
> Support/Reflect/`) was rejected to keep the graph self-contained.

## Schema (first wave)

Mirrors the indexing-strategy projections: `notes`, `note_text`, `links`, `backlinks`,
`tags`, `aliases` (feeds resolution + rename), `assets`, `search_fts` (FTS5 over title +
body), `index_meta` (schema version, last rebuild, embedding model). Plans 11, 12, 09 add
`web_captures`, `sync_state`/`conflicts`, `embedding_*`: additive, no rewrite.

## Steps

1. **Rust DB layer:** open/migrate, load FTS5, expose query/execute/batch + `index_*`
   commands. Migrations are ordered SQL gated by `user_version`.
2. **Kysely dialect bridge** (`packages/db`). **Validation scope (revised):** zod-validate
   external data (file contents, provider responses, command payloads), but **do not
   `zod.parse` every index row**: the index is our own projection from a known schema, and
   per-row validation is real overhead on large FTS scans. **Fallback:** if the dialect is
   painful (transactions, returning, JSON/blob params), use named typed Rust query commands;
   the getters' API does not change.
3. **Indexing pipeline (TS core, Rust applies the write).** Read → parse + extract in TS
   (Plan 03) → hash → skip if unchanged → else one `db_batch` upsert (incl. recomputed
   backlinks for affected targets) applied by Rust in **one transaction**.
4. **File watching + echo suppression.** `notify` watcher over the graph (excluding
   `.reflect/`), debounced and queued, never parsing inline. **Index only `.md` under
   `daily/` + `notes/` (and track `assets/`)**; ignore other files. Handle editor temp
   files, sync duplicates (`note 2.md`), and not-yet-downloaded placeholders (skip +
   retry). **Suppress our own writes:** the writer registers `(path, expected-hash)` just
   before an atomic write and the watcher drops matching events. Match the hash, not just
   the path, so a real external edit racing our write is still caught.

   Engineer comment: would it be simpler to not track our own edits and make the watcher
   the sole re-index path (edit → markdown → watcher → debounced re-index)?

5. **Full rebuild + repair.** Wipe derived tables and re-scan on first open, schema bump,
   "repair", or embedding-model change. Non-rebuildable local state (UI prefs,
   last-opened) lives where rebuild never touches it.
6. **Change detection by content hash**, not mtime (sync providers rewrite mtimes).
   Reconcile on open: hash mismatch → re-index; missing path → remove.
7. **Tests.** Fixture graph rows; external edit reindexes only that file; delete DB →
   rebuild reproduces identical projections; own autosave does **not** reindex.

## Key decisions / contracts

- **The DB is a cache.** Deleting `.reflect/index.sqlite` loses nothing durable
  (rebuild-equivalence test).
- **All writes go through Rust transactions**; the frontend only reads and requests index
  operations, which avoids races with the watcher.
- **Content-hash change detection** for sync robustness.
- **Parsing is TS; only the SQLite write is Rust.** zod guards external boundaries only.
- **The index never lives in a cloud-synced folder unredirected.**

## Acceptance criteria

- Opening a graph populates `notes`, `links`, `backlinks`, `tags`, `aliases`.
- An external `.md` edit reindexes just that file within the debounce window.
- A rebuild from empty reproduces byte-identical projections.
- FTS5 returns hits for a known phrase.

## Risks

- **Watcher storms** during `git pull` / bulk sync: debounce + batch + a "syncing"
  suppression flag (with Plan 12).
- **FTS5 availability:** verified in the Plan 01 spike; bundle SQLite with FTS5.
- **Large-graph rebuild time:** batched transactions + progress events.
