# Reflect V2 Indexing Strategy

The V2 indexing direction: a local database for fast lookup, search, backlinks, semantic
search, and AI context, with markdown files as the durable source of truth. It complements
[Reflect V2 Product Vision](./reflect-v2-product-vision.md).

> **Status (2026-06-12): shipped as designed**, with these specifics:
>
> - SQLite lives at `<graph>/.reflect/index.sqlite`. The desktop writer and the read-only
>   `reflect` CLI share migrations via the `index-schema` crate.
> - Canonical parser: `@lezer/markdown` (GFM + a first-party wiki-link extension), shared
>   by the editor and the indexer. Note identity: lowercase ULID `id:` in frontmatter plus
>   readable slug filenames (Plan 17).
> - FTS5 lexical search; semantic search via `sqlite-vec` with **local embeddings**
>   (fastembed/ONNX in Rust, outside the WebView; model downloaded on demand). Chunks are
>   hashed so unchanged chunks are not re-embedded.
> - **One durable exception to "projections only":** the `chat_*` tables hold AI chat
>   history, which is not derivable from markdown. Index wipes/rebuilds must leave them
>   untouched.
> - Link-capture provenance lives in normal markdown/frontmatter plus asset references; a
>   separate `web_captures` projection has not been added yet.

## Strategy

Markdown files are the durable content source. SQLite holds rebuildable projections and
local app state under an ignored `.reflect/` directory inside the workspace. Any
non-rebuildable database state must be deliberately justified.

SQLite is the default because it is local, durable, embeddable, portable, well understood,
and works on desktop and mobile. It holds structured projections, full-text search, and
vectors via extensions. Keeping it under `.reflect/` keeps the workspace self-contained
while keeping binary indexes out of GitHub backup and file-sync providers.

A pure markdown-folder app is portable but too slow for Reflect's UX: scanning files on
every interaction fails on large workspaces and mobile. The database is a local index and
cache over the markdown, not a proprietary storage model.

- **Rebuildable projections:** title, frontmatter, plain text, outgoing and incoming links,
  tags, aliases, daily-note date, headings, search rows, semantic chunks.
- **Possibly non-rebuildable local state:** UI preferences, last opened note, sidebar
  state, sync adapter references, conflict review state, and AI conversation history (the
  `chat_*` tables, the one sanctioned exception).
- **Secrets** do not belong in SQLite or `.reflect/` unless a later security design picks
  encrypted local storage. BYOK keys and GitHub credentials live in the per-device OS
  keychain.

The original proposal expected projections for notes, note text, links, backlinks, tags,
aliases, assets, web captures, FTS, embedding chunks and vectors, sync state, and
conflicts.

## Vector Indexes

- Notes split into sentence-aware chunks, each referencing its note path, ID, heading, and
  range where practical.
- Chunks are hashed; only new or changed chunks are embedded (mirrors V1).
- Vectors are stored locally in sqlite-vec. Search runs by vector distance, then
  deduplicates chunks back to notes.
- The embedding model/runtime is recorded per vector, so the index can be rebuilt when the
  model or chunking changes.
- First-wave embeddings run locally, not through BYOK cloud APIs. The default model is
  downloaded on demand, not bundled.

V2 can run embeddings outside the WebView because it has no web app. What must survive
from V1 is local chunking, local embedding, local vector storage, and incremental updates.

Be honest about the cost: local embeddings keep chunks off external providers, but need
model downloads, device checks, indexing time, storage, and graceful unavailable states.
BYOK generative AI (chat, editing) stays separate from semantic search.

## Rebuild And Repair

Rebuild from the markdown workspace on: first open, a parser/schema upgrade, external
edits, sync pulls, an embedding model or runtime change, or a manual repair request.
Deleting and recreating derived indexes must never lose notes, and rebuilds preserve
non-rebuildable state.

## File Watching

Files can change outside Reflect. The indexer handles creates, modifies, deletes, renames,
temporary files from editors or sync providers, sync-provider conflict copies, and files
the OS or cloud provider has not downloaded. Watching enqueues indexing work instead of
parsing inline.

## AI Context Retrieval

The AI sidebar asks a retrieval layer for context (current note, selection, backlinks,
lexical and semantic matches, nearby sections, recent dailies) instead of scanning the file
system. Notes with `private: true` may stay in local indexes, but their content must never
reach cloud AI providers. Retrieval exposes enough metadata for the AI layer to exclude
them while still allowing local-only recall.

## Sync Interaction

Sync and indexing are separate but coordinated: sync adapters write markdown, then notify
the indexer, which updates projections. Conflicts use the normalized model in
[Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md). The database does not become
the sync source of truth unless a future decision changes the architecture. `.reflect/` is
ignored by backup; markdown and attachment files are the durable data boundary.

## Mobile Indexing

The first mobile app supports lexical search over titles, bodies, and backlinks. Local
semantic search on mobile comes later, after validating model runtime, battery, storage,
latency, and GitHub-backed workspace behavior. Mobile shares desktop's markdown and sync
assumptions without forcing the desktop design to solve mobile vector indexing first.

## Open Questions

Resolved (see the status note): parser `@lezer/markdown`; lowercase ULID `id:`
frontmatter; fastembed/ONNX in Rust; chat history in durable `chat_*` with a moving
context window.

Still open:

- Should vector search stay in sqlite-vec long term or move behind a vector-store adapter?
- How should mobile graduate from lexical search to local semantic search?
