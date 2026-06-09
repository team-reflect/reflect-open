# Plan 04 — Local Index (SQLite)

**Goal:** Build the rebuildable SQLite projection over the markdown graph: metadata,
links/backlinks, tags, aliases, plain text, and FTS — kept fresh by file watching and
fully reconstructable from files.

**Depends on:** Plan 02 (file IO), Plan 03 (extraction output).
**Unlocks:** Plan 06 (daily lookup), 07 (backlinks), 08 (lexical search), 09 (chunks),
10 (AI retrieval), 14 (CLI).

**Libraries:** `rusqlite` (bundled, FTS5) + `notify` + `notify-debouncer-full` +
`blake3` (Rust); `kysely` (TS query builder). See [Libraries](libraries.md).

## Scope

**In:** where SQLite runs, Kysely wiring, schema/projections, FTS5, the indexing
pipeline (parse → upsert), file watching, incremental + full rebuild, repair, schema
versioning.
**Out:** vectors/embeddings (Plan 09, additive tables), sync state tables (Plan 12 adds
them), query UX (Plan 08).

## Key architectural decision: SQLite runs in Rust, Kysely builds the SQL

The repo mandates **Kysely** for DB types, but `sqlite-vec` (Plan 09) and FTS5 must be
loaded as native SQLite extensions — only practical in the Rust process, not the WebView.
Resolution:

- **SQLite lives in Rust** (`rusqlite` with bundled SQLite; load FTS5 + later
  `sqlite-vec`). The DB file is `<graph>/.reflect/index.sqlite`.
- **The frontend uses Kysely purely as a typed query builder** with a tiny custom
  dialect/driver that *compiles* queries to `{ sql, params }` and ships them over a
  Tauri command (`db_query` / `db_execute`) to Rust for execution. Rows return as JSON,
  **zod-validated at the IPC boundary** (Plan 01).
- This keeps end-to-end types + the Kysely requirement, while extensions, migrations,
  and write transactions stay in Rust where they belong.
- **Homes** (per [Architecture & Conventions](architecture-conventions.md)): the schema +
  IPC dialect live in `@reflect/db`; **getters** live in `@reflect/core` actions
  (`actions/<domain>/getters.ts`). Adopt full **Kysely discipline** —
  `Selectable/Insertable/Updateable` in every signature (never raw table types), the
  `json()` helper for JSON columns, camelCase normalized at the zod/IPC boundary.

```ts
// packages/db/src/schema.ts — Kysely table interfaces (source of TS types)
export interface NotesTable {
  id: string            // ULID or path-derived for dailies
  path: string          // graph-relative
  title: string
  dailyDate: string | null   // 'YYYY-MM-DD' or null
  isPrivate: number     // 0|1 (SQLite has no bool)
  fileHash: string      // content hash for change detection
  mtime: number
  updatedAt: number
}
export interface Database {
  notes: NotesTable
  links: LinksTable
  backlinks: BacklinksTable
  tags: TagsTable
  aliases: AliasesTable
  noteText: NoteTextTable
  // search_fts is an FTS5 virtual table managed in Rust
}
```

### Alternatives considered: `wa-sqlite` (client-side WASM)

V1 used [`wa-sqlite`](https://github.com/rhashimoto/wa-sqlite) (a WASM SQLite that
Reflect sponsored) and stored data in IndexedDB/OPFS. That was correct **for V1's
constraint: a browser web app with no native process**, where WASM was the only way to
get local SQLite. **V2 removes that constraint** (Tauri ships a native Rust process), so
the rationale no longer holds. Running `wa-sqlite` in the WebView is rejected here,
chiefly on **file permissions**:

- **The index must live on the real filesystem, beside the notes** (`<graph>/.reflect/
  index.sqlite`, gitignored) so it is inside the graph, deleted with it, and readable by
  the Node CLI (Plan 14). A WebView's `wa-sqlite` persists to **OPFS/IndexedDB inside the
  WebView's sandbox** — not a real file at a known path. That breaks the in-graph
  `.reflect/` model, portability/inspectability, and kills the CLI (a Node process can't
  open an OPFS-stored DB).
- **macOS file access is a native-layer concern.** Persistent access to a user-chosen
  folder under the sandbox/hardened runtime uses **security-scoped bookmarks** + FS
  entitlements, which only the native process can hold. The WebView/JS context can't
  request them — it only sees what Rust hands it.
- **Cross-process locking** (desktop app + read-only CLI on the same `index.sqlite`)
  needs real POSIX advisory locks + WAL `-shm`/`-wal` on the real file. `wa-sqlite`'s
  OPFS VFS uses its own in-sandbox locking that a separate native process can't
  coordinate with.
- **Making `wa-sqlite` write the real graph file** would require a Rust-backed VFS
  bridging every page read/write over IPC — reintroducing Rust into the data path with
  *worse* latency than just running SQLite in Rust.
- **Extensions + perf:** FTS5 and `sqlite-vec` load natively in Rust; bundling them into a
  custom WASM build is extra pipeline, and WASM query/vector perf is slower on large
  graphs. Embeddings already run in Rust (Plan 09).

`wa-sqlite` would only buy us no per-query IPC (Kysely could run a JS dialect directly) —
outweighed by the above. Revisit only for a hypothetical pure-web build, which V2 does
not target.

> **Sub-decision — where the index file lives: DECIDED — inside the graph.** The index is
> `<graph>/.reflect/index.sqlite`, alongside the notes and gitignored, so the graph stays
> self-contained, the index is deleted with the graph, and the CLI (Plan 14) can find it.
> This requires write access to the graph folder, which the native (Rust) process holds
> via macOS security-scoped bookmarks + FS entitlements. (The app-data-dir alternative —
> keying an index under `~/Library/Application Support/Reflect/` — was considered and
> rejected to keep the graph self-contained.)

## Schema (first wave)

Mirror the indexing-strategy projection table list:

- `notes` — one row per file: path, id, title, daily date, `private`, file hash, mtimes.
- `note_text` — extracted plain text (for FTS + AI context).
- `links` — outgoing wiki + markdown links (source note, target text/href, position).
- `backlinks` — derived incoming links (resolved target id ← source note).
- `tags` — tag ↔ note.
- `aliases` — alias ↔ note (feeds wiki-link resolution + rename, Plan 07).
- `assets` — attachment metadata (path, referencing notes, size).
- `search_fts` — FTS5 virtual table over title + body (+ asset text later).
- `index_meta` — schema version, last full-rebuild time, embedding model (Plan 09).

(`web_captures`, `sync_state`, `conflicts`, `embedding_*` tables are added by Plans 11,
12, 09 respectively — additive, no rewrite.)

## Steps

1. **Rust DB layer** (`src-tauri/src/db/`): open/migrate the SQLite file, load FTS5,
   expose `db_query`/`db_execute`/`db_batch` commands + an `index_*` command set.
   Migrations are ordered SQL with a `user_version` pragma gate.

2. **Kysely dialect bridge** (`packages/db`): custom driver compiling Kysely queries and
   invoking `db_query`. Typed `Database` interface from the schema above. **Validation
   scope (revised):** zod-validate genuinely external data (file contents, provider
   responses, command *payloads*), but **don't `zod.parse` every row of every query** —
   the index is our own projection that Rust serializes from a known schema; row-by-row
   validation is real overhead on large FTS scans. Trust the Kysely types for index reads;
   add a dev-only shape assertion if desired. **Fallback:** if the custom dialect proves
   painful (transactions, returning, JSON/blob params), drop to a handful of named typed
   query commands in Rust — the getters' public API doesn't change.

3. **Indexing pipeline (TS core, Rust applies the write).** Given a changed file, the
   `@reflect/core` indexer (TS): read (Plan 02 primitive) → **parse + extract in TS**
   (Plan 03, Lezer) → compute `fileHash` → if unchanged, skip → else hand a single
   `db_batch` upsert (`notes`/`note_text`/`links`/`tags`/`aliases` + recomputed
   `backlinks` for affected targets) to Rust, which applies it in **one transaction**.
   Backlinks resolve via the alias/title rules from Plan 03.

4. **File watching + echo suppression.** Rust `notify`-based watcher over the graph
   (excluding `.reflect/`). Debounce + enqueue; do not parse inline. **Only index `.md`
   under `daily/`+`notes/` (and track `assets/`); ignore everything else** (other apps'
   files, `.DS_Store`, dotfiles). Handle create/modify/delete/rename, editor temp files,
   sync duplicate-conflict files (`note 2.md`), and not-yet-downloaded placeholder files
   (skip + retry). **Suppress our own writes** so autosave doesn't loop: the writer
   registers `(path, expected-hash)` in a short-lived suppression set immediately before
   an atomic write; the watcher drops events whose path+hash match (hash match, not just
   path, so a *real* external edit racing our write is still caught). Emit a Tauri event so
   the UI can refresh.

   Engineer comment: is it simpler that we don't keep a track of files we've edited, and
   instead have this watcher as the sole path for re-indexing? i.e. user edits note, markdown
   updated, watcher notified, search re-indexed (debounced).

5. **Full rebuild + repair.** `index_rebuild()` wipes derived tables and re-scans the
   graph. Triggers: first open, schema-version bump, "repair" action, embedding-model
   change (Plan 09). Preserve non-rebuildable local state (UI prefs, last-opened) — store
   that in a separate table/file that rebuild never touches.

6. **Change-detection correctness.** Use content hash, not just mtime (sync providers
   rewrite mtimes). Reconcile on open: any file whose hash ≠ stored row is re-indexed;
   any indexed path missing on disk is removed.

7. **Tests.** Index a fixture graph; assert backlinks/tags/aliases rows. Edit a file
   on disk → watcher reindexes only it. Delete the DB → full rebuild reproduces identical
   projections (the "rebuildable" guarantee). Our own autosave must **not** trigger a
   reindex (echo-suppression test).

## Key decisions / contracts

- **The DB is a cache.** Deleting `.reflect/index.sqlite` must lose nothing durable.
  Enforced by the rebuild-equivalence test.
- **All writes go through Rust transactions**; the frontend only reads (via Kysely) and
  requests index operations. This avoids write races with the watcher.
- **Content-hash change detection**, not mtime, for sync robustness.
- **Parsing/extraction is TS (core); only the SQLite write is Rust.** zod guards external
  boundaries, not internal index reads.
- **The index never lives in a cloud-synced folder unredirected** (see above).

## Acceptance criteria

- Opening a graph indexes it; `notes`, `links`, `backlinks`, `tags`, `aliases` populated.
- Editing a `.md` outside the app reindexes just that file within the debounce window.
- `index_rebuild()` from empty reproduces byte-identical projections (test-asserted).
- FTS5 returns hits for a known phrase.
- `pnpm typecheck` + targeted tests pass.

## Risks

- **Watcher storms** during `git pull` / bulk sync. Mitigate with debounce + batch
  reindex + a "syncing" suppression flag (coordinated with Plan 12).
- **FTS5 availability** in the bundled SQLite. Verified in the Plan 01 spike; bundle
  SQLite with FTS5 compiled in.
- **Large graphs** (10k+ notes) rebuild time. Mitigate with batched transactions +
  progress events; keep parsing in Rust or a worker if needed.
