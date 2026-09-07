# Incremental search maintenance

Two independent sources of unnecessary work on large graphs: FTS mutations
selected an `UNINDEXED` path, and semantic backfill still read, parsed, queried
and applied every note even when no inference was needed.

## FTS identity

Migration 0023 introduces `note_search`, with a unique indexed note path and an
integer FTS rowid. Replacement preserves that identity; rename moves its path.
The optional user-authored `notes.id` is independent. Existing FTS rows, ranking,
snippets and durable chat history survive migration. Rebuild clears the mapping
through its note foreign key and reconstructs it alongside FTS.

`EXPLAIN QUERY PLAN` shows the difference: `DELETE FROM search_fts WHERE path = ?`
plans as `INDEX 0:` (no usable constraint, a full scan) while the rowid form
plans as `INDEX 0:=`. Replacing every FTS row of an already populated
in-memory index (debug build, macOS arm64, SQLite 3.53.4, short synthetic
bodies), by path versus by rowid:

| Notes | Delete by path | Delete by rowid |
| ---: | ---: | ---: |
| 2,000 | 1.06 s | 0.03 s |
| 10,000 | 24.8 s | 0.14 s |

Reproduce with the ignored Rust benchmark:

```sh
pnpm --filter @reflect/desktop sidecar
cargo test -p reflect-open benchmark_fts_replacement_by_path_versus_rowid -- --ignored --nocapture
```

It measures only the FTS delete and insert, not the other projection tables,
IPC or UI work, so it is not a startup or save-latency prediction.

## Embedding checkpoints

Migration 0024 adds `embedding_state`, written atomically with a successful
complete chunk projection, including an empty chunk set. A fingerprint includes
note path, indexed content hash, model, embedding projection version and referenced
description-file revisions. Path is included because relative asset resolution
can change after a rename. Asset revisions include size and modification/creation
time, plus file identity and change time on Unix and Windows. Filesystems that
cannot supply reliable change metadata defer affected notes without reading or
hydrating their descriptions. Touching unchanged description
files can cause conservative reprocessing while retaining existing vectors.

Discovery performs one native database query and checks metadata for each unique
referenced description. It returns only dirty work and never reads note bodies,
parses markdown, queries chunk rows or writes checkpoints for clean notes. The
metadata work runs outside the writer lock. Individual unavailable descriptions
are deferred so other notes can proceed.

Preparation rechecks each candidate, and note/description reads use the pinned
index root without downloading evicted iCloud files. TypeScript verifies the
actual note hash and resolved asset dependencies. Native apply rechecks the input
fingerprint before changing chunks or the checkpoint. Failures, unavailable
content and raced changes remain eligible for a later pass. A graph's first pass
after upgrading establishes checkpoints using retained vectors; later clean
passes avoid per-note processing.

Discovery runs once the index reconcile has finished and again after every
later reconcile, so notes a reconcile wrote are already candidates; bulk index
passes do not broadcast the index-applied signal (its other subscriber, the
asset-description controller, must only see watcher batches). The live queue
coalesces repeated paths, runs during bulk candidate discovery, and drains
between bulk notes. Native note
deletion already removes chunks and checkpoints atomically, so a delayed frontend
remove cannot wipe a newly recreated note. Rename preserves vectors, with path
semantics rechecked before recording a new checkpoint. Migration 0025 records
`notes.projection_path`: a moved row keeps its old projection path until normal
indexing reparses its relative references, even if the bytes and mtime match.
This marker survives an interrupted pass and is checked by both watcher work and
reconciliation. The migration stamps existing rows as projected at their current
path; the projection version bump that shipped before it already rebuilt every
row, so upgrading does not reproject the graph. Rebuild clears derived
checkpoints and vectors while retaining chat history.

This does not change provider routing: embedding inference remains local, and
external AI privacy gates are unchanged. Discovery remains linear in indexed
notes plus unique description references; it eliminates full-note work rather
than all bookkeeping. No native launch, WebKit input latency, or physical-device
battery measurements were made.

## Embedding measurements

The TypeScript pipeline was measured with 10,000 synthetic 1,136-byte notes
and instant mocked native IPC. Before this change a clean graph made 10,000
reads, 10,001 queries, 10,000 applies and zero inference calls. After it, a
clean graph makes one candidate-selection call and zero prepares, note reads,
chunk queries, applies or inference calls; ten dirty notes among 10,000 make
ten prepares, reads, chunk queries and applies, without new inference because
the chunk hashes still match. `pipeline.work-count.test.ts` asserts these
counts on every CI run.

A separate native debug-build benchmark includes the real SQLite discovery
query and input hashing. With no asset references, it took 6.84 ms for 1,000
clean notes and 63.71 ms for 10,000; one dirty note returned one candidate at
6.81 ms / 63.98 ms. Both cases made zero SQLite writes. The two harness timings
are independent observations, not an end-to-end measurement.

```sh
pnpm test --run packages/core/src/embeddings/pipeline.work-count.test.ts
pnpm --filter @reflect/desktop sidecar
cargo test -p reflect-open benchmark_clean_and_single_dirty_discovery -- --ignored --nocapture
```
