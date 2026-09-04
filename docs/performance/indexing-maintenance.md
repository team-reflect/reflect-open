# Incremental search maintenance

The September 4, 2026 audit found two independent sources of unnecessary work:
FTS mutations selected an `UNINDEXED` path, and semantic backfill still read,
parsed, queried and applied every note even when no inference was needed.

## FTS identity

Migration 0021 introduces `note_search`, with a unique indexed note path and an
integer FTS rowid. Replacement preserves that identity; rename moves its path.
The optional user-authored `notes.id` is independent. Existing FTS rows, ranking,
snippets and durable chat history survive migration. Rebuild clears the mapping
through its note foreign key and reconstructs it alongside FTS.

Synthetic in-memory SQLite 3.53.4 measurements on macOS arm64, including the new
mapping's maintenance:

| Operation | Previous path scan | Indexed mapping |
| --- | ---: | ---: |
| Populate 2,000 notes | 0.2026 s | 0.0273 s |
| Populate 10,000 notes | 4.8805 s | 0.1502 s |
| Replace 10,000 notes | 10.1995 s | 0.1760 s |
| Remove the last of 50,000 notes (median) | 4.3785 ms | 0.0105 ms |

An existing-note removal used 11,111 / 110,111 / 550,111 SQLite VM instructions
at 1k / 10k / 50k notes before the change. The mapping path used 157 at each size;
a missing-note removal used 20. These counts isolate the removed scan, rather
than depending solely on timing.

Reproduce from the repository root:

```sh
python3 docs/performance/fts-benchmark.py "$PWD"
```

The SQL harness uses short synthetic bodies and the production mapping migration.
It excludes other note projection tables, native invocation, disk I/O and UI work.
Its timings are not application startup or save-latency predictions.

## Embedding checkpoints

Migration 0022 adds `embedding_state`, written atomically with a successful
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

The live queue coalesces repeated paths, runs during bulk candidate discovery,
and drains between bulk notes. Native note
deletion already removes chunks and checkpoints atomically, so a delayed frontend
remove cannot wipe a newly recreated note. Rename preserves vectors, with path
semantics rechecked before recording a new checkpoint. Migration 0023 records
`notes.projection_path`: a moved row keeps its old projection path until normal
indexing reparses its relative references, even if the bytes and mtime match.
This marker survives an interrupted pass and is checked by both watcher work and
reconciliation. The migration reprojects existing asset-bearing notes once to
repair references left stale by older renames; evicted notes retain their vectors
and wait for local content instead of being downloaded for this repair. Rebuild clears derived
checkpoints and vectors while retaining chat history.

This does not change provider routing: embedding inference remains local, and
external AI privacy gates are unchanged. Discovery remains linear in indexed
notes plus unique description references; it eliminates full-note work rather
than all bookkeeping. No native launch, WebKit input latency, or physical-device
battery measurements were made.

## Embedding measurements

The actual TypeScript pipeline was measured with 10,000 synthetic 1,136-byte
notes and instant mocked native IPC. The audit baseline took 10.07 seconds and
made 10,000 reads, 10,001 queries, 10,000 applies and zero inference calls.
After this change, a clean graph made one candidate-selection call and zero
prepares, note reads, chunk queries, applies or inference calls. With ten dirty
notes among 10,000, it made ten prepares, reads, chunk queries and applies,
without new inference because the chunk hashes still matched. TS-only times
ranged from 0.14–0.29 ms clean and 8.88–19.22 ms for ten dirty notes; these exclude native candidate
selection and must not be interpreted as full backfill time.

A separate native debug-build benchmark includes the real SQLite discovery
query and input hashing. With no asset references, it took 6.84 ms for 1,000
clean notes and 63.71 ms for 10,000; one dirty note returned one candidate at
6.81 ms / 63.98 ms. Both cases made zero SQLite writes. The two harness timings
are independent observations, not an end-to-end measurement.

```sh
pnpm test --run packages/core/src/embeddings/pipeline.benchmark.test.ts
pnpm --filter @reflect/desktop sidecar
cargo test -p reflect-open benchmark_clean_and_single_dirty_discovery -- --ignored --nocapture
```
