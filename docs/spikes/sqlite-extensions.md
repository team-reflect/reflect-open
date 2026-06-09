# Spike — SQLite FTS5 + sqlite-vec in the Rust shell (Plan 01 §8)

**Question:** Do the two SQLite extensions Reflect depends on load in the **bundled SQLite
running inside the Tauri Rust process** — FTS5 for lexical search (Plan 04) and sqlite-vec
for vector search (Plan 09)? This is the storage gate behind the "SQLite-through-Rust"
decision (see [Plan 04 alternatives](../plans/04-local-index-sqlite.md)).

**Verdict: GO — both work.** `cargo test` is green:

```text
test db::tests::fts5_is_compiled_in ... ok
test db::tests::sqlite_vec_loads_and_runs_knn ... ok
```

## Method

- Added to `apps/desktop/src-tauri`: `rusqlite 0.40` with the **`bundled`** feature
  (libsqlite3-sys 0.38 — compiles SQLite from source) and **`sqlite-vec 0.1.9`**.
- `src-tauri/src/db.rs`: a `register_sqlite_vec()` that registers the extension once via
  `sqlite3_auto_extension`, plus `open_in_memory()`.
- Two headless `cargo test` cases: an FTS5 virtual table + `MATCH` query, and a `vec0`
  virtual table + KNN (`ORDER BY distance LIMIT k`) query returning the nearest row.

## Findings

1. **FTS5 is compiled in by default** with rusqlite's `bundled` feature — no extra build
   flag or define needed. Create/insert/`MATCH` all work.
2. **sqlite-vec registers and runs** via the documented `sqlite3_auto_extension` +
   `sqlite_vec::sqlite3_vec_init` pattern. `vec_version()`, `vec0` tables, and KNN queries
   work.
3. **sqlite-vec is statically linked** through the Rust crate — there is **no separate
   `.dylib`** to ship or code-sign. That removes a notarization worry for the vector store
   (the ONNX/embedding *runtime* in Plan 09 is still a separate signed-dylib concern;
   they're different dependencies). Updated mental model vs the Plan 09/15 note.
4. Incremental test build was ~21s (the cold `bundled` SQLite compile is the one-time cost);
   binary size + compile time grow accordingly.

## Implications

- Confirms **SQLite-through-Rust** (Plan 04): FTS5 + sqlite-vec live in the Rust process;
  the Kysely-over-IPC query builder sits above. `wa-sqlite`-in-the-WebView remains rejected
  (Plan 04 alternatives).
- Plan 04 can build `search_fts` (FTS5) and Plan 09 `embedding_vectors` (vec0) on this
  foundation. `db.rs`'s `open_in_memory` is the seed for the on-disk graph-index connection.

## Caveats

- **sqlite-vec 0.1.x is pre-1.0** — keep vector access behind the Plan 09 `retrieve()` API
  so the store can be swapped without touching callers.
- Bundled SQLite increases compile time and binary size (acceptable; expected).
