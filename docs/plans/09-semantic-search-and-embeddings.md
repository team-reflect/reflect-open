# Plan 09 — Semantic Search & Local Embeddings

**Goal:** Local-only semantic search and a shared retrieval layer: chunk notes, embed
them locally (no cloud embedding APIs), store vectors in SQLite, and serve nearest-note
retrieval to search and AI.

**Depends on:** Plan 04 (index + chunk source), Plan 08 (search surface to augment).
**Unlocks:** Plan 10 (AI context retrieval rides this layer).

**Architecture:** the embedding runtime (model download + `embed`) is a Rust primitive;
chunking, the `retrieve()` API, and ranking live in `@reflect/core` (`actions/embeddings`,
`actions/search`). See [Architecture & Conventions](architecture-conventions.md).

**Libraries:** `fastembed` (Rust, local embeddings) + `sqlite-vec` (vectors). See
[Libraries](libraries.md).

## Scope

**In:** local embedding runtime in Rust, sentence-aware chunking, `sqlite-vec` storage,
incremental (hash-based) re-embedding, a unified retrieval API, blended lexical+semantic
results, graceful unavailable states, `private: true` handling.
**Out:** BYOK/cloud embeddings (explicitly not first wave), mobile semantic search
(lexical-only first), generative AI (Plan 10).

## Key decision: embeddings run locally, in Rust, outside the WebView

Per the indexing strategy: **first-wave embeddings are local, not cloud BYOK**, and
embedding execution should leave the WebView for performance.

- **Runtime:** a Rust embedding crate (e.g. `fastembed`/ONNX Runtime) running a small
  sentence-embedding model (e.g. `all-MiniLM-L6-v2` / `bge-small`). The **model is
  downloaded on demand**, not bundled, with device-capability checks + a graceful
  "semantic search unavailable" state on unsupported devices.
- **Storage:** `sqlite-vec` virtual tables in the same `.reflect/index.sqlite` (loaded in
  Rust alongside FTS5, Plan 04).
- **The recorded embedding model/runtime per vector** so the index can be rebuilt when the
  model changes.

## Schema additions (additive to Plan 04)

- `embedding_chunks` — chunk id, note id, heading, char/line range, text, content hash.
- `embedding_vectors` — `sqlite-vec` table: chunk id ↔ vector, with model id.
- `index_meta.embeddingModel` — current model identifier (rebuild trigger on change).

## Steps

1. **Chunking.** Split note plain text (Plan 03 extraction) into sentence-aware chunks
   with stable back-references (note path/id, heading, range). Hash each chunk so
   unchanged chunks are not re-embedded — mirrors V1 behavior.

2. **Rust embedding service** (`src-tauri/src/embed/`): load/download model; `embed(texts)
   → vectors`; commands `embed_index_note(id)` and `embed_rebuild()`. Runs off the UI
   thread; reports progress via events.

3. **Incremental pipeline.** On note index (Plan 04), diff chunk hashes; embed only
   new/changed chunks; upsert into `sqlite-vec`; drop vectors for removed chunks. Full
   `embed_rebuild()` on model change or repair.

4. **Retrieval API (shared contract).** One `retrieve(query, opts)` that returns ranked
   note/chunk hits, used by both search and AI:

   ```ts
   export interface RetrievalHit {
     noteId: string
     chunkId: string
     score: number
     snippet: string
     heading?: string
     isPrivate: boolean
   }
   export interface RetrieveOptions {
     limit: number
     mode: 'semantic' | 'lexical' | 'hybrid'
     excludePrivateContent: boolean // AI callers set true
   }
   ```
   Vector search → dedupe chunks back to notes → optionally blend with FTS (hybrid).

5. **Search integration.** Add a semantic/hybrid toggle to the `⌘K` surface (Plan 08):
   "meat dishes" finds recipe notes lacking those exact words. Same UI, additive ranking.

6. **Privacy contract.** `private: true` notes may stay in the **local** lexical + vector
   indexes (local recall is fine), but retrieval used for cloud AI (Plan 10) must exclude
   their *content*. `RetrieveOptions.excludePrivateContent` + per-hit `isPrivate` give the
   AI layer what it needs to filter before any external call. Enforced again at the AI
   call site (defense in depth).

7. **Tests.** Chunk stability + hash-skip (unchanged note re-embeds nothing); vector round
   trip; hybrid ranking sanity; private content excluded when
   `excludePrivateContent: true`; unavailable-model path degrades to lexical-only.

## Key decisions / contracts

- **Local embeddings only** for first wave; cloud embeddings explicitly out.
- **Embeddings in Rust, model downloaded on demand**, recorded per vector for rebuilds.
- **One `retrieve()` API** is the single retrieval contract for search + AI.
- **Private notes: locally recallable, never sent to cloud** — enforced in retrieval and
  again at the AI boundary.

## Acceptance criteria

- First semantic use downloads the model with progress; later uses are instant.
- Semantic/hybrid search finds conceptually-related notes lacking exact keywords.
- Editing a note re-embeds only changed chunks (hash-skip verified).
- `retrieve({ excludePrivateContent: true })` never returns private-note content.
- On an unsupported device, search degrades to lexical with a clear state.
- `pnpm typecheck` + tests pass.

## Risks

- **Whole feature is independently deferrable.** Semantic search is the riskiest infra
  here (native ML runtime + model + vector store). It sits behind the `retrieve()` API and
  a capability check, so **M2 can ship on lexical search alone** (Plan 08) if this slips —
  keep it strictly additive, never a blocker for search/AI.
- **Bundling a native ML runtime is heavy** (ONNX Runtime is a large dependency, ships a
  **dylib that must be code-signed for notarization** — Plan 15, both arm64 + x64), and
  adds build/CI complexity. Mitigate: gate behind capability detection; consider a sidecar
  process so a runtime crash can't take down the app.
- **Model download size/time + device variance.** Mitigate with on-demand download,
  capability checks, progress UX, and a lexical fallback.
- **`sqlite-vec` maturity / portability.** Keep vector access behind the retrieval API so
  the store can be swapped without touching callers (noted open question).
- **Indexing latency on large graphs.** Background, batched, incremental; never block
  the editor or search.
