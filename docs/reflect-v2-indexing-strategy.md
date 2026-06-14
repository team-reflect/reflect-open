# Reflect V2 Indexing Strategy

This document captures the current V2 indexing direction. It focuses on using a local database for fast lookup, search, backlinks, semantic search, and AI context while keeping markdown files as the durable source of truth.

It complements [Reflect V2 Product Vision](./reflect-v2-product-vision.md).

> **Status (2026-06-12) — shipped as designed**, with these specifics:
>
> - SQLite lives at `<graph>/.reflect/index.sqlite`; migrations are shared between the
>   desktop writer and the read-only `reflect` CLI via the `index-schema` crate.
> - Canonical parser: `@lezer/markdown` (GFM + a first-party wiki-link extension),
>   shared by the editor and the indexer. Note identity: lowercase ULID `id:` in
>   frontmatter plus readable slug filenames (Plan 17).
> - FTS5 lexical search; semantic search via `sqlite-vec` with **local embeddings**
>   (fastembed/ONNX in Rust, outside the WebView; model downloaded on demand).
>   Chunks are hashed so unchanged chunks are not re-embedded.
> - **One durable exception to "projections only":** the `chat_*` tables hold AI chat
>   history, which is not derivable from markdown. Index wipes/rebuilds must leave
>   them untouched.
> - Link-capture provenance now lives in normal markdown/frontmatter plus asset
>   references; a separate `web_captures` projection has not been added yet.

## Strategy

Reflect V2 should use a local projection database.

Markdown files should remain the user's durable source of truth. The local database should make the app fast, searchable, and AI-native, but it should be rebuildable from the markdown workspace wherever practical.

SQLite is the committed first default because it is local, durable, embeddable, portable, well understood, and compatible with desktop and mobile app architectures. It can store structured projections, full-text search tables, and vector-search data via extensions or companion libraries.

The first implementation should store SQLite and generated local state under an ignored `.reflect/` directory inside the workspace. This keeps the workspace self-contained while keeping binary indexes and transient state out of GitHub backup and file-sync providers.

## Why A Local Database Is Needed

A pure markdown-folder app is portable, but it is not enough for Reflect's intended UX.

V2 needs fast local access to:

- Note metadata.
- Daily-note lookup.
- Backlinks and incoming backlinks.
- Tags and aliases.
- Full-text search.
- Semantic search chunks and embeddings.
- AI context retrieval.
- File modification state.
- Sync state and conflict state.
- Attachment metadata.
- Web capture provenance and screenshot asset references.
- UI state that should not live in markdown.

Scanning markdown files on every interaction would make the app feel slow, especially on large workspaces and mobile devices. The database should act as a local index and cache over the markdown source.

## Source Of Truth

The default rule should be:

- Markdown files are the durable content source.
- SQLite stores rebuildable projections and local app state under ignored `.reflect/`.
- Any non-rebuildable database state must be deliberately justified.

Rebuildable projections include:

- Title.
- Frontmatter metadata.
- Plain text.
- Outgoing backlinks.
- Incoming backlinks.
- Tags.
- Aliases.
- Daily-note date.
- Headings.
- Link targets.
- Search rows.
- Semantic chunks.

Potentially non-rebuildable local state includes:

- UI preferences.
- Last opened note.
- Collapsed sidebar state.
- Sync adapter credentials or references.
- Conflict review state.
- AI conversation history (shipped as the durable `chat_*` tables — the one sanctioned non-rebuildable exception; rebuilds must preserve them).

Secrets do not belong in SQLite or `.reflect/` unless a later security design explicitly chooses encrypted local storage there. BYOK model keys and GitHub credentials should live in per-device OS keychain or secure storage.

## Suggested SQLite Projections

The exact schema is TBD, but future implementation should expect tables or equivalent indexes for:

| Projection          | Purpose                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `notes`             | One row per markdown note, with path, title, ID, timestamps, daily date, and file hash. |
| `note_text`         | Plain text extracted from markdown for search and AI context.                           |
| `links`             | Outgoing wiki links and markdown links.                                                 |
| `backlinks`         | Derived incoming backlinks.                                                             |
| `tags`              | Tags from frontmatter and markdown content.                                             |
| `aliases`           | Alternate note names from frontmatter or link syntax.                                   |
| `assets`            | Attachment/file metadata.                                                               |
| `web_captures`      | Derived URL, title, capture time, source, screenshot, and highlight metadata.           |
| `search_fts`        | Full-text search index.                                                                 |
| `embedding_chunks`  | Chunked note text prepared for embeddings.                                              |
| `embedding_vectors` | Vector embeddings for semantic search.                                                  |
| `sync_state`        | Adapter checkpoints, file versions, and pending operations.                             |
| `conflicts`         | Normalized conflicts awaiting AI/user resolution.                                       |

This should be treated as a projection layer, not as a proprietary storage model.

## Vector Indexes

Semantic search and AI context retrieval likely require vector indexes.

V2 should assume:

- Notes are split into chunks.
- Each chunk has stable references back to note path, note ID, heading, and byte/line range where practical.
- Embeddings are stored locally.
- The vector index can be rebuilt when the embedding model or chunking strategy changes.
- The app tracks the embedding model/provider used for each vector.
- First-wave embeddings are generated locally, not through BYOK cloud APIs.
- The default local embedding model is downloaded on demand rather than bundled into the app.

The first implementation should mirror the V1 embedding model behavior where possible:

- Split note text into sentence-aware chunks.
- Hash chunks so unchanged chunks do not need to be re-embedded.
- Embed only new or changed chunks.
- Store vectors locally in SQLite through sqlite-vec where supported.
- Search by vector distance, then deduplicate chunk results back to notes.
- Keep the embedding model/runtime recorded so indexes can be rebuilt after model changes.

V2 may move embedding execution out of the WebView for performance because V2 does not need to support a web app. The important part to preserve is the V1 indexing behavior: local chunking, local embedding, local vector storage, and incremental updates.

The product should be honest about privacy and performance. Local embeddings avoid sending note chunks to an external provider, but they may require model downloads, device capability checks, indexing time, storage space, and graceful unavailable states on unsupported devices.

BYOK generative AI should remain separate from semantic search. User-provided OpenAI or other model keys can power chat and editing, but first-wave semantic indexing should not send note chunks to cloud embedding APIs.

## Rebuild And Repair

The app should be able to rebuild indexes from the markdown workspace.

Rebuild triggers:

- First workspace open.
- App upgrade that changes parser/index schema.
- User edits files outside Reflect.
- Sync adapter pulls changes.
- Embedding model changes.
- User manually requests repair.
- Local embedding runtime changes or becomes unavailable.

Rebuild should preserve non-rebuildable local state when possible. It should be safe to delete and recreate derived indexes without losing markdown notes.

## File Watching

Because markdown files can be edited outside Reflect, the app needs robust file watching.

The indexer should handle:

- Created files.
- Modified files.
- Deleted files.
- Renamed files.
- Temporary files from editors or sync providers.
- Duplicate conflict files from sync providers.
- Files not currently downloaded by the OS or cloud provider.

File watching should enqueue indexing work rather than doing heavy parsing inline.

## AI Context Retrieval

The local index should power the AI sidebar.

The AI context system should retrieve:

- Current note content.
- Selected text.
- Incoming and outgoing backlinks.
- Lexical search matches.
- Semantic search matches.
- Nearby headings or sections.
- Recent daily notes if relevant.

The AI should not need to scan the file system directly. It should ask the retrieval layer for context, and the retrieval layer should use the local indexes.

Notes with `private: true` may remain in local lexical and semantic indexes, but their content must not be returned to cloud AI providers as prompt context. Retrieval APIs should surface enough metadata for the AI layer to exclude locked notes from external calls while still allowing local-only recall.

## Sync Interaction

The indexing layer and sync layer should be separate but coordinated.

Sync adapters should write or update markdown files, then notify the indexer. The indexer should parse changed files and update projections. Conflicts should be recorded in the local database using the normalized conflict model described in [Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md).

The local database should not become the sync source of truth unless a future decision explicitly changes the architecture.

The `.reflect/` directory should be ignored by GitHub backup by default. It may contain rebuildable indexes and non-content local state, but the sync layer should treat markdown and attachment files as the durable data boundary.

## Mobile Indexing

The first mobile app should support lexical search over titles, bodies, and backlinks. Local semantic search on mobile should come later, after the team validates model runtime, battery cost, storage size, indexing latency, and GitHub-backed workspace behavior.

Mobile should share the same markdown and sync assumptions as desktop, but it should not force the first desktop architecture to solve local vector indexing on iOS or Android immediately.

## Open Questions

Resolved (see the status note above): the canonical parser is `@lezer/markdown`; note
IDs are lowercase ULID `id:` frontmatter; the local embedding runtime is fastembed/ONNX
in Rust; chat history persists durably in `chat_*` with a moving context window.

Still open:

- Should vector search stay in sqlite-vec long term or move behind a vector-store adapter?
- How should mobile graduate from lexical search to local semantic search?
