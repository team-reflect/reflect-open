# Plan 09 — Semantic Search & Local Embeddings

**Goal:** Local-only semantic search and a shared retrieval layer: chunk notes, embed
them locally (no cloud embedding APIs), store vectors in SQLite, and serve nearest-note
retrieval to search and AI.

**Depends on:** Plan 04 (index + chunk source), Plan 08 (search surface to augment).
**Unlocks:** Plan 10 (AI context retrieval rides this layer).

**Architecture:** the embedding runtime (model download + `embed`) is a Rust primitive;
chunking, `retrieve()`, and ranking live in `@reflect/core`. See
[Architecture & Conventions](architecture-conventions.md).

**Libraries:** `fastembed` (Rust, local embeddings) + `sqlite-vec` (vectors). See
[Libraries](libraries.md).

## Delivery (decided 2026-06-09)

Both halves ship on one branch, commits sequenced runtime-first so the native risk is
reviewable in isolation:

- **09a — runtime + vector store:** `fastembed` **in-process, off-thread** (sidecar
  only if crashes materialize) with **all-MiniLM-L6-v2** (384-dim, ~90MB), downloaded
  on demand into app data with status in the operations store. Same recoverable-init
  contract as sqlite-vec: failure means "semantic unavailable", never a crash.
  Migration 0002 adds `embedding_chunks`, the `vec0` table, and
  `index_meta.embeddingModel`. Vector writes are generation-pinned commands; KNN reads
  go through the ordinary read-only `db_query` (sqlite-vec accepts JSON-text vectors,
  so no bespoke read command).
- **09b — chunking, retrieval, hybrid search, related notes:** pure sentence-aware
  chunker in core; incremental hash-diff embedding on the post-index-apply hook (TS
  orchestration, Rust stays primitives); one `retrieve()` with **reciprocal rank
  fusion** (deterministic, no tuned weights); **⌘K is hybrid by default with no
  toggle** (exact lexical matches keep top billing through RRF, and the surface falls
  back to lexical-only without the model); and a **related-notes panel** under
  backlinks (the Plan 07 "suggested backlinks" deferral), seeded by the note's own
  content, self-excluded, hidden when unavailable.

**Consequences:** `fastembed` pulls ONNX Runtime, whose dylib must be code-signed at
notarization (Plan 15). Model-dependent Rust tests are gated behind an ignored
integration flag; unit tests use a fake embedder. kysely-codegen replays migrations
through better-sqlite3, so codegen loads the `sqlite-vec` npm extension to create the
`vec0` table.

## Scope

**In:** local Rust embedding runtime, sentence-aware chunking, `sqlite-vec` storage,
hash-based incremental re-embedding, one retrieval API, blended lexical+semantic
results, unavailable states, `private: true` handling.
**Out:** BYOK/cloud embeddings, mobile semantic search (lexical-only first),
generative AI (Plan 10).

## Key decision: embeddings run locally, in Rust, outside the WebView

Per the indexing strategy, first-wave embeddings are local, not cloud BYOK, and run
outside the WebView for performance. The model is **downloaded on demand**, not bundled,
with a graceful "semantic search unavailable" state on unsupported devices. Vectors live
in `.reflect/index.sqlite` next to FTS5. **The model is recorded per vector** so the
index rebuilds when it changes.

## Steps

1. **Chunking:** sentence-aware chunks with stable back-references (note, heading,
   range). Hash each chunk so unchanged chunks are not re-embedded (mirrors V1).
2. **Rust embedding service:** load/download model, embed off the UI thread, report
   progress via events.
3. **Incremental pipeline:** on note index, embed only new/changed chunks and drop
   vectors for removed ones. Full rebuild on model change or repair.
4. **One `retrieve()` contract** for search and AI: semantic, lexical, or hybrid mode;
   hits carry `isPrivate`; callers can set `excludePrivateContent`. Vector hits dedupe
   back to notes, optionally blended with FTS.
5. **Search integration:** hybrid ⌘K with no toggle (see Delivery), so "meat dishes"
   finds recipe notes lacking those words. Lexical-only when the model is unavailable.
6. **Privacy contract:** `private: true` notes may stay in the **local** indexes (local
   recall is fine), but retrieval for cloud AI (Plan 10) must exclude their content.
   `excludePrivateContent` + per-hit `isPrivate` let the AI layer filter before any
   external call; the AI call site enforces it again (defense in depth).
7. **Tests:** hash-skip (unchanged note re-embeds nothing), vector round trip, hybrid
   ranking sanity, private exclusion, unavailable-model fallback to lexical.

## Key decisions / contracts

- **Local embeddings only** for first wave; cloud embeddings out.
- **Embeddings in Rust, model downloaded on demand**, recorded per vector for rebuilds.
- **One `retrieve()` API** for search + AI.
- **Private notes: locally recallable, never sent to cloud**, enforced in retrieval and
  again at the AI boundary.

## Acceptance criteria

- First semantic use downloads the model with progress; later uses are instant.
- Hybrid search finds conceptually related notes lacking exact keywords.
- Editing a note re-embeds only changed chunks.
- `retrieve({ excludePrivateContent: true })` never returns private-note content.
- On an unsupported device, search falls back to lexical with a clear state.

## Risks

- **Independently deferrable.** This is the riskiest infra here (native ML runtime +
  model + vector store). It sits behind `retrieve()` and a capability check, so **M2 can
  ship on lexical search alone** (Plan 08). Keep it strictly additive.
- **Heavy native runtime:** ONNX Runtime is large, ships a dylib that must be signed for
  notarization (arm64 + x64), and adds CI complexity. Gate behind capability detection;
  a sidecar could stop a runtime crash from taking down the app.
- **Model download size and device variance:** on-demand download, capability checks,
  progress UX, lexical fallback.
- **`sqlite-vec` maturity:** keep vector access behind `retrieve()` so the store can be
  swapped without touching callers.
- **Indexing latency on large graphs:** background, batched, incremental; never block
  the editor or search.
