# Reflect V2 Product Vision

This document describes the intended direction for Reflect V2: an open-source, local-first, markdown-native rewrite of Reflect that preserves the strongest ideas from V1 while making substantial architectural and product changes.

It is written for future implementation agents and engineers. It should be read alongside:

- [Reflect V1 Overview](./reflect-v1-overview.md)
- [Reflect V2 Grounding Brief](./reflect-v2-grounding-brief.md)
- [Reflect V2 Indexing Strategy](./reflect-v2-indexing-strategy.md)
- [Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md)

## Product Thesis

Reflect V2 should be a beautiful, local-first, AI-native markdown app for personal memory.

The app should preserve Reflect's core insight: people capture life chronologically, then understand it associatively. Daily notes remain the default capture surface, backlinks remain the organizing primitive, and search remains the recall layer. The major change is that V2 should be built on open, inspectable, portable markdown files instead of an encrypted cloud-first note database.

V2 should feel like Reflect, but it should be easier to trust, easier to extend, easier to back up, and easier for AI to work with.

## Principles To Preserve From V1

### Daily Notes First

Daily notes should remain the first screen and the default place to capture thoughts, meetings, journals, links, tasks, audio notes, and rough material.

V2 should keep the daily note as the chronological spine of the product:

- Opening the app lands on today's note.
- Creating quick text defaults to today's note.
- Future and past daily notes are valid places to write.
- Search and backlinks can jump to dates naturally.
- Daily notes can later become the context for tasks, meetings, and reviews.

The storage layer may be markdown files, but the product should still feel daily-first.

### Association Over Hierarchy

Reflect V2 should continue to prioritize backlinks over folders as the primary organization model.

Folders may exist because markdown files live in a file system, but they should not become the main product abstraction. The main organizing model should be:

- Notes link to notes.
- Daily notes link to people, projects, companies, ideas, and events.
- Incoming backlinks create context automatically.
- Search and AI use these links as memory structure.

### Fast Capture

V2 should be optimized for fast capture before heavy organization.

The user should be able to:

- Open the app and type immediately.
- Create a backlink without leaving the keyboard.
- Save the current browser page into Reflect without choosing a filing system first.
- Create or open daily notes quickly.
- Search instantly.
- Ask the AI copilot about the current note or related notes without constructing a workflow.

### Keyboard-Native UX

Keyboard operation is part of Reflect's identity. V2 should keep this.

Important workflows should have direct keyboard paths:

- Open search.
- Open today's daily note.
- Create a new note.
- Create backlinks.
- Invoke the AI sidebar.
- Move between editor and sidebar.
- Accept, reject, or apply AI edits.

### User-Owned Data

V2 should make ownership tangible. Notes should be real markdown files that users can inspect, copy, back up, version, and edit with other tools.

The app can maintain a local database for performance, but the user's durable knowledge should not be locked inside the database.

## Major Departures From V1

### Markdown Is The Source Of Truth

V1 stores rich ProseMirror/Yjs documents and sync metadata. V2 should store notes as markdown files.

The app may use a local database for indexes, metadata, backlinks, semantic embeddings, and fast UI projections, but those should be rebuildable from files wherever possible.

### No E2EE-First Architecture

V1 treated end-to-end encryption as a core constraint. V2 should not.

This is an intentional product shift. V2 is AI-native, markdown-native, and local-first. Built-in E2EE would make search, semantic indexing, AI workflows, open protocols, and simple backup harder. Instead, privacy should come from:

- Local-first storage.
- User-controlled files.
- Transparent AI calls.
- Bring-your-own-key AI.
- Clear controls over what context is sent to AI providers.
- Optional encrypted backup/sync layers later, if they fit the product.

V2 should not pretend that cloud AI and universal E2EE are naturally compatible. If the user sends note context to OpenAI or another provider, the product should make that clear.

### No Web App In The Initial Product

V2 should target desktop and mobile apps, not a web app.

The initial focus should be:

- Mac desktop first.
- iOS/mobile planned.
- Windows possible later.
- Android possible later.

This lets V2 lean into local files, native file access, local indexes, OS integrations, and app-like AI workflows.

### No Reflect-Hosted APIs

V2 should not depend on Reflect-hosted application APIs.

The core product should be a local app that talks directly to user-approved providers when it needs outside services:

- LLM and transcription calls go directly to model providers using user credentials or explicit provider configuration.
- Backup and sync calls go directly to GitHub, Git, iCloud Drive, local folders, or other user-chosen adapters.
- Link enrichment should not use a Reflect-hosted replacement for V1's link description API.
- Capture, indexing, AI context selection, markdown writes, and sync conflict handling should run locally in the app wherever practical.

This is a hard trust and architecture principle, not merely a launch simplification. Future business models should not assume Reflect operates proprietary note, AI, sync, capture, or link-description APIs for the local-first core product.

### No Electron

V2 should not use Electron.

The implementation should leave room for Tauri, a native shell with a WebView, or another lightweight app architecture. The exact shell can remain open, but the product direction should be:

- Lower memory footprint than Electron.
- Strong local file system integration.
- Native-feeling desktop UX.
- Shared app/editor core where practical.

### Open Source Core

V2 should be open source at the core.

The app, local storage format, editor behaviors, and protocol assumptions should be inspectable and community-extensible. The business model is TBD; V2 should not assume a specific monetization path yet.

The open-source promise should apply to the local app and storage model first. The intended license for the open-source core is MIT.

## Lessons From Obsidian

Obsidian is the strongest adjacent proof that users trust a local markdown vault. Reflect V2 should learn from Obsidian without becoming an Obsidian clone.

The lesson is not that Reflect should maximize plugins or configurability. The lesson is that open files create trust, and a coherent first-party intelligence layer can make those files feel alive.

### What To Borrow

V2 should borrow these Obsidian strengths:

- **Boring vault durability**: markdown files and attachments should remain inspectable, portable, and useful outside Reflect.
- **Complete link ergonomics**: `[[Wiki Links]]`, standard markdown links, aliases, rename handling, heading links where practical, and fast autocomplete should feel boringly reliable.
- **Visible metadata**: frontmatter should be inspectable and editable, but it should stay minimal. Use it for identity, aliases, `private: true`, provenance, and small atomic metadata rather than turning notes into hidden database records.
- **Backlinks as ambient context**: incoming links should be available while writing, not only as search results.
- **Recoverability**: sync state, version history, deleted-file recovery, and conflict review should use plain product language even if Git is the underlying adapter.
- **User-shaped workflows**: users want to adapt their notes environment. V2 should support this first through open files, CLI discovery, and `~/.agents` prompt/command context rather than a broad plugin API.

### Where Reflect Should Differ

Obsidian's AI story is largely ecosystem-led. That proves demand, but it also creates a fragmented experience: different plugins own retrieval, embeddings, chat, editing, local models, provider settings, and privacy behavior.

Reflect V2 should make AI-native behavior a coherent product layer:

- One right-sidebar copilot with access to current note context, visible retrieved context, backlinks, lexical search, and local semantic search.
- One privacy model, including `private: true` hard-blocks for cloud AI and cloud transcription.
- One reviewed patchset model for note edits, including multi-note edits and opt-in background extraction.
- One retrieval layer shared by search, backlinks, AI context, and future capture/import workflows.
- One conflict-resolution flow where AI can propose merges but content conflicts remain reviewable.
- One controlled extensibility model based on local files, read/discovery CLI commands, and `~/.agents` prompt/command discovery.

Reflect V2 should avoid making users assemble an AI note-taking system from plugins. The core product should own context selection, retrieval, patch review, privacy boundaries, and provenance from the start.

## Storage Model

### Markdown Files

Notes should be stored as markdown files on disk.

Recommended default:

- One note per markdown file.
- Daily notes stored in `daily/YYYY-MM-DD.md`.
- Regular notes stored in `notes/`.
- Attachments stored in `assets/` and referenced with relative markdown links.
- File names should be stable and human-readable where possible.
- Stable note IDs should live in frontmatter.
- Frontmatter should stay minimal and exist only for metadata that markdown cannot represent cleanly.

This default directory layout must satisfy:

- Users can back up the folder without Reflect.
- Users can inspect and edit files outside Reflect.
- The app can rebuild its local index from files.
- Backlinks remain valid across renames where practical.
- Attachments remain normal files, not database blobs.

Large binary attachments need GitHub backup guardrails. The first-wave app should support local attachment files, but it should warn or limit GitHub backup for large binaries rather than making Git LFS or user-chosen object storage a first-wave requirement.

### Local Database And Indexes

V2 should use a local database/index layer for derived state. SQLite is the committed first default.

This local layer can store:

- Parsed note metadata.
- Backlink graph.
- Incoming backlinks.
- Tags.
- Daily-note dates.
- Full-text search index.
- Semantic search chunks and embeddings.
- AI context cache.
- File modification state.
- UI state.

The local database should be treated as a cache/projection unless a specific field cannot safely live in markdown. Any non-rebuildable local state should be deliberately justified. See [Reflect V2 Indexing Strategy](./reflect-v2-indexing-strategy.md) for the proposed projection and vector-index model.

SQLite and other generated local state should live under an ignored `.reflect/` workspace directory. This keeps the workspace self-contained while preventing binary indexes, credentials, and transient state from being committed to GitHub or synced as durable note content.

### Suggested File Semantics

V2 should assume this initial file contract:

- Markdown body is the primary content.
- `[[Wiki Links]]` are canonical backlinks.
- Standard markdown links should still work.
- YAML frontmatter should include stable identity and app-specific metadata only when needed.
- `private: true` marks a note as locked from cloud AI. It means note content must not be sent to BYOK or cloud model providers for chat, edits, conflict resolution, agents, or background context. It is not a general encryption, backup, GitHub, or local-search privacy guarantee.
- Aliases may be stored in frontmatter so backlinks can survive renames and external edits.
- The parser should tolerate external edits.
- Invalid or unknown frontmatter should not make a note unreadable.
- Known backlinks should be rewritten on rename, and the previous title should be preserved as an alias.

## Editor Vision

V2 needs an exceptionally good markdown editor.

The editor should feel like WYSIWYG markdown:

- Users write markdown, but the editor renders it beautifully in place.
- Formatting should not feel like editing a plain textarea.
- Markdown syntax should remain available and portable.
- Backlinks should autocomplete and render naturally.
- Daily note links should feel first-class.
- Standard markdown links, headings, lists, quotes, code blocks, tables, images, and checkboxes should work.

The editor should be opinionated, calm, and fast. It should preserve Reflect's minimal feel while making markdown approachable.

### Backlinks

Canonical backlink syntax should be `[[Wiki Links]]`.

V2 should support:

- Creating backlinks with `[[`.
- Autocomplete over existing notes.
- Creating a note from an unresolved backlink.
- Showing incoming backlinks.
- Renaming notes without breaking common links where possible.
- Aliases, likely through frontmatter or explicit alias syntax.

Standard markdown links should also be supported for external links and file/path links. The app should not force all links into wiki syntax.

### Daily Notes

Daily notes should have stable markdown files and predictable note identities.

Daily notes should default to `daily/YYYY-MM-DD.md`. The date should be derivable from the path; title frontmatter should not be required for normal daily notes.

V2 should support `[[2026-06-08]]` as a date-note link. Natural-language date links can be explored later, but ISO date links should be the first stable contract.

## AI-Native Model

V2 should be AI-native from the start.

The primary AI interface should be a right-sidebar note copilot, similar in spirit to Cursor's sidebar. It should understand the current note and be able to search across other local notes for context.

### Initial AI Capabilities

First-wave AI should support:

- Chatting about the current note.
- Summarizing the current note.
- Rewriting selected text.
- Generating edits that can be reviewed and applied.
- Searching related notes for context.
- Answering questions using local notes.
- Suggesting backlinks or related notes.
- Extracting action items or structured follow-ups as text.

The AI should have editing capabilities over notes, including multi-note patches. Edits should be represented as patchsets. Risky, destructive, or broad edits require review. Low-risk patchsets may be auto-applied only after Reflect has created a local checkpoint and only when locked notes are excluded.

### Context Model

The AI sidebar should have access to:

- Current note content.
- Current selection.
- Incoming and outgoing backlinks.
- Search results from local full-text search.
- Search results from local semantic search.
- User-selected additional context.
- Other notes retrieved through the local search and semantic-search layers.

The AI should make it clear what context it is using. The default UX can provide visible/current context and retrieved context, but the user should be able to see or understand the note context being used. If note content is sent to an external provider, that should be transparent.

Notes with `private: true` are hard-blocked from cloud AI. They may remain locally searchable and may participate in local semantic retrieval, but their content must not be sent to BYOK model providers, cloud model providers, or external agent tools.

### BYOK First

V2 should start with bring-your-own-key AI. (As shipped: OpenAI, Anthropic, Google, and OpenRouter keys, stored in the OS keychain.)

The architecture should leave room for:

- Other model providers.
- Local generative models later.
- More agentic workflows later.

But the product should not require Reflect-operated AI infrastructure to be useful. Any cloud AI call should go directly from the app to the chosen model provider, using user-owned credentials or explicit provider configuration.

BYOK generative AI is separate from semantic search. First-wave semantic search should use local embeddings, not BYOK cloud embeddings.

### Future Agentic Workflows

The AI sidebar should be designed so it can grow into more capable workflows:

- Create new notes.
- Edit multiple notes.
- Build summaries across a time period.
- Extract people/projects/entities.
- Generate daily or weekly reviews.
- Suggest note cleanup.
- Create tasks if tasks are later ported.

These should not all be first-wave requirements. The first wave should establish the note copilot and context/search foundation.

## Search And Intelligence

Search is core to V2.

First-wave search should include:

- Local lexical search.
- Title search.
- Backlink-aware search.
- Semantic search.
- Search results usable as AI context.

Search should be local-first. Embeddings should be generated locally and stored locally for the first-wave product. BYOK cloud embeddings are not a first-wave requirement.

The search system should operate over markdown files plus the local projection database. It should tolerate external file edits and rebuild when needed.

## Link Capture

> **Status:** Link capture is now implemented for the desktop Chrome-extension path:
> extension → native-messaging host → capture inbox → desktop markdown/assets write →
> async BYOK enrichment. Safari/mobile share targets, full article clipping, and
> read-later state remain later work; [Plan 11](./plans/11-link-capture.md) is the
> current implementation contract.

V2 should include basic link capture. This is narrower than a full browser clipper, but it is still part of Reflect's daily-first capture spine.

The V1 implementation has a useful shape to preserve: browser capture creates a link record, a client-side operation turns that into a link note, and the daily note gets a `[[Links]]` entry pointing at the captured item. The V1 implementation also calls `link-description-api.vercel.app/describe` for an AI-generated summary. V2 should preserve the product behavior, but not the Reflect-hosted API shape.

V2 should invert that architecture:

- The Chrome extension captures the active URL, page title, selected text or highlights, and a screenshot when available.
- The extension sends the capture to the installed desktop app through a local desktop capture bridge.
- The desktop app owns all durable writes, file paths, AI provider calls, keychain access, and privacy checks.
- The user's BYOK AI credentials, especially OpenAI keys, are used by the desktop app to produce a link description from the URL, screenshot, title, and selected text.
- The extension must not store model provider keys.
- The result should be saved as markdown and assets, then indexed like any other note content.

The bridge should be an implementation adapter, not a product assumption. Native messaging is the preferred first spike for Chrome because it is an official extension-to-native-app channel and avoids exposing a local HTTP port. A loopback HTTP bridge can remain a fallback if screenshot payload size, streaming, or platform packaging makes native messaging awkward. A `reflect://` deep link is acceptable only as a URL-only fallback because it is too limited for screenshots, structured metadata, retries, and reviewable errors. A Reflect-hosted cloud relay should not be used for the core capture path.

The default saved shape should be:

- A link capture appended to today's daily note under a `[[Links]]` section.
- A dedicated markdown note for richer captures when the description, highlights, or screenshot make the item worth preserving as a durable object.
- Screenshot files stored under `assets/` and referenced with relative markdown links.
- Minimal provenance in frontmatter or markdown: original URL, captured title, captured time, source extension, screenshot asset path, selected text/highlights, and AI provider/model used for the description.

AI enrichment must obey the same privacy model as the rest of V2. If the target note or capture is marked `private: true`, Reflect must not send the URL contents, screenshot, selected text, or resulting note content to cloud AI. The product can still save the raw link locally without AI enrichment.

## Platform Strategy

### Mac First

The first desktop app should target macOS.

Mac-first does not mean Mac-only forever. It means product quality, local file access, editor polish, and AI workflow quality matter more than broad platform parity at launch.

### No Web App

V2 should not assume a browser-hosted web app.

This simplifies:

- Local file access.
- Local indexing.
- OS-level key storage.
- Native menus and shortcuts.
- Offline behavior.
- Backup integration.

### Mobile Planned

Mobile should be part of the product direction, but it does not need to block the first Mac release.

The first mobile product should focus on:

- Capture into today's daily note.
- Reading notes.
- Lexical title/body/backlink search.
- Backup/sync compatibility with desktop.

Full editor parity, local semantic search, heavy AI workflows, and complex conflict review can come later after the desktop architecture proves the storage, sync, and indexing model.

### Shell Spike

> **Resolved:** the spike happened and **Tauri 2 is the shipped desktop shell** (React/
> TypeScript frontend in a Rust native shell, with the `reflect` CLI bundled as a
> sidecar). The paragraph below is preserved as the original decision framing.

V2 should not commit to Tauri or a native Mac shell before a focused spike.

The spike should compare Tauri against a native Mac shell with WebView using the real editor, local file access, SQLite/indexing, GitHub backup, keyboard behavior, and window/menu requirements.

### Future Windows And Android

Windows and Android should remain possible. The implementation should avoid choices that make them impossible, but should not over-optimize for them before the Mac product is excellent.

## Backup And Sync Strategy

> **Status (2026-06-12):** the first release ships the Git adapter only — GitHub via
> device-flow auth, plus generic git remotes over SSH/path. File-sync folder providers
> (iCloud Drive/Dropbox/Drive) are **unsupported for sync by design** in the first wave
> (see Plan 12); the adapter list below is the long-term direction. AI-assisted conflict
> resolution did not ship — conflicts surface as reviewable conflict markers with
> mine/theirs/both resolution.
>
> **Update (2026-07-04):** [Plan 21](./plans/21-icloud-drive-sync.md) shipped
> **iCloud Drive as the primary consumer sync path** — the app's own container,
> iCloud-first onboarding on macOS and iOS, and deterministic on-device conflict
> resolution (see [icloud-sync.md](./icloud-sync.md)). Git remains the
> self-managed adapter; a graph syncs via iCloud *or* a Git remote, never both.
> AI-assisted resolution stays deferred.

V2 should make backup free and understandable.

The app should support a user-controlled backup path without requiring a Reflect account or Reflect-operated infrastructure.

Sync should use an adapter pattern. The product should define a stable internal sync interface, then allow different adapters to implement it over time. Git/GitHub should be treated as the first serious backup/sync adapter target, but not as an irreversible architecture commitment.

Possible backup/sync adapters:

- Git repository backup and history.
- GitHub remote backup and multi-device sync.
- Local folder backup.
- iCloud Drive or OS-level file sync.
- Dropbox/Google Drive-style folder sync.
- Future protocol-based sync.

The product should distinguish:

- **Backup**: user can recover data.
- **Sync**: multiple devices converge safely.
- **Collaboration**: multiple users edit shared content.

The app should hide adapter complexity from normal users. If a Git adapter is used, the UI should not expose commits, branches, rebases, or merge markers as product concepts. Users should see plain language like "Backed up", "Syncing", "Needs review", and "Resolved".

GitHub setup should let the user choose a repository rather than assuming Reflect creates a managed private repo. Reflect should still configure safe defaults, ignores, and recovery behavior where possible.

### Adapter-Normalized Conflict Resolution

Reflect should normalize sync conflicts into a generic conflict model. Git conflicts, iCloud Drive duplicate files, local-folder conflicts, and future provider/protocol conflicts should all become the same kind of Reflect conflict before they reach the UI or AI.

Git becomes more plausible as a sync layer if Reflect owns the conflict-resolution experience. The AI can treat every conflict like a markdown merge task, then Reflect can translate the accepted resolution back into adapter-specific operations.

V2 should explore AI-assisted conflict resolution for markdown notes:

- Detect when the sync adapter produces a file conflict.
- Parse the conflicting markdown versions into a structured diff.
- Ask the AI copilot to propose a merged note that preserves both users/devices' intent.
- Show the proposed resolution as a reviewable patch.
- Let the user accept, edit, or reject the resolution.
- Keep the raw conflicting versions recoverable.

AI conflict resolution should be a product layer above the sync adapter. Git may be the first beneficiary, but the same reviewable conflict-resolution flow should be reusable for other adapters. Note-body conflicts should require user review. Automatic resolution should be limited to trivial non-content conflicts unless a later product decision explicitly expands that safety boundary. See [Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md) for the proposed adapter and conflict model.

V2 first wave should commit to backup, local ownership, and a sync adapter boundary. A full sync implementation can remain TBD until the file format, conflict model, and mobile story are clearer.

## Feature Migration Matrix

### First-Wave V2 Features

These should be treated as core to the V2 vision:

| Feature            | V2 direction                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Daily notes        | Preserve as default capture surface.                                                                |
| Markdown editor    | Beautiful WYSIWYG markdown editor.                                                                  |
| Markdown files     | Durable source of truth.                                                                            |
| Backlinks          | `[[Wiki Links]]` as canonical syntax.                                                               |
| Incoming backlinks | Preserve as core context.                                                                           |
| Local search       | Required.                                                                                           |
| Semantic search    | Required on supported desktop runtimes; mobile can start lexical-only.                              |
| AI note copilot    | Required right-sidebar experience.                                                                  |
| BYOK AI            | Required initial AI model.                                                                          |
| Link capture       | Implemented for the desktop Chrome-extension path (Plan 11): native host/inbox bridge, daily note entry, dedicated capture note, screenshots, BYOK enrichment. |
| Portability        | Required for trust: the graph folder itself is the portable artifact; no dedicated import/export suite is planned. |
| Backup             | Free/open backup path required.                                                                     |
| Open-source core   | Required.                                                                                           |
| Local DB/index     | Allowed and expected for projections.                                                               |
| Attachments        | Local `assets/` files with relative markdown links and GitHub guardrails.                           |
| CLI                | Read/discovery commands such as `reflect search`, `reflect show`, `reflect today`, and path lookup. |

### Deferred V1 Features

These may come later, but should not define the first wave:

| Feature                  | V2 stance                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Tasks                    | Defer from the first release; now planned as a post-release add-on (Plan 18): round-checkbox (`+ [ ]`) tasks as a lightweight markdown-backed projection. |
| Audio transcription      | **Shipped early** (despite this table): raw-first audio memos with async BYOK cloud transcription and `private: true` lockouts. |
| Full browser clipper     | Defer beyond launch link capture. Article extraction, read-later state, and broad clipping can come later.         |
| Graph/map view           | Defer. Keep backlink graph data, but visual map is not first-wave.                                                 |
| Templates                | Defer or keep lightweight. Markdown snippets may be enough initially.                                              |
| Contacts/calendar        | Defer. Valuable later for meetings and personal CRM workflows.                                                     |
| Publishing               | Defer. Public artifacts conflict with local-first file assumptions and need separate design.                       |
| Additional sync adapters | Defer beyond GitHub-first target. Define the adapter boundary early.                                               |
| Reflect-hosted sync      | Not part of the V2 baseline. The core product should not depend on Reflect-hosted APIs.                            |
| Business model           | TBD. Do not assume a monetization model yet.                                                                       |
| V1 migration             | Desirable later, but not a first-wave constraint.                                                                  |
| Plugin API               | Defer. Use `~/.agents` prompt/command discovery, not a public plugin API.                                          |

### Intentionally Dropped Or Reframed

| V1 concept                                 | V2 direction                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| End-to-end encryption as core architecture | Drop as a default premise; replace with local ownership and transparent AI/privacy controls. |
| Firebase-first backend                     | Drop. V2 should not need a cloud backend for core use.                                       |
| Reflect-hosted application APIs            | Drop. Provider calls should go directly from the app to the chosen provider.                 |
| Web app parity                             | Drop for initial product.                                                                    |
| Electron desktop app                       | Drop.                                                                                        |
| Proprietary storage model                  | Drop. Markdown files are core.                                                               |
| Server-mediated note sync as default       | Reframe as TBD/pluggable.                                                                    |

## Product Architecture Defaults

Implementation details are not final, but future agents should start from these defaults unless the product direction changes:

- **Workspace**: a local folder/vault with `daily/`, `notes/`, `assets/`, and ignored `.reflect/`.
- **Source of truth**: markdown files.
- **Daily notes**: `daily/YYYY-MM-DD.md`.
- **Note identity**: readable filenames plus stable frontmatter IDs.
- **Projection layer**: SQLite under ignored `.reflect/`, rebuilt from files wherever practical.
- **Backlinks**: `[[Wiki Links]]`, stable identity resolution, rename rewrite plus aliases.
- **Attachments**: normal files under `assets/` with relative markdown links.
- **AI privacy**: `private: true` hard-blocks cloud AI use of note content.
- **AI**: BYOK generative provider calls with visible/current context and local retrieval, excluding locked notes.
- **AI edits**: multi-note patchsets, checkpointed before application; unsafe edits require review.
- **Search**: local lexical search and local-only semantic embeddings.
- **Link capture**: shipped for the desktop Chrome-extension path. The extension sends URL/title/selection/screenshot data to a native host/inbox bridge; the desktop app uses BYOK AI, writes markdown/assets, and appends the capture to today's daily note. Safari/mobile share targets and full article clipping remain later work.
- **Audio memos**: shipped — raw-first capture (the recording is the durable artifact), async BYOK cloud transcription with `private: true` cloud-processing lockouts.
- **Network model**: no Reflect-hosted APIs for the core product; external calls go directly to user-approved providers such as LLM providers, GitHub, Git remotes, iCloud Drive, or cloud transcription providers.
- **Desktop shell**: Mac-first, no Electron, spike Tauri against a native WebView shell.
- **Mobile**: capture/read/lexical search first; same sync assumptions later.
- **Backup/sync**: adapter-based; GitHub is the first serious target, with user-chosen repositories.
- **Conflict handling**: AI may propose merges; content conflicts are reviewable, trivial non-content conflicts may auto-resolve.
- **CLI**: read/discovery operations first, including search, show, today's daily note, and surfacing note paths. Manual edits to markdown files are the write path; no separate write CLI is needed initially.
- **Extensions**: no public plugin API first wave; discover `~/.agents` prompt/command context only.
- **Secrets**: per-device OS keychain or secure storage; never markdown, Git, or `.reflect`.
- **Open source**: MIT-licensed local app and storage/protocol core.

## Open Questions

These should remain explicit until answered:

- How much Git complexity can be fully hidden from users?
- Which conflict edge cases need stricter review than the default content-conflict policy?
- How should mobile eventually access and mutate the same GitHub-backed workspace?
- Which safe multi-note AI patches can auto-apply without review? (The first release ships the copilot read-only; patchsets are a later wave.)
- What command/skill subset should `~/.agents` discovery expose inside Reflect?
- What business model, if any, belongs in the long-term product?
- What is the eventual V1 migration path?

## Definition Of Success

Reflect V2 succeeds if a user can:

1. Install a Mac app.
2. Open today's markdown daily note instantly.
3. Write in a beautiful markdown editor without thinking about files.
4. Create `[[Wiki Links]]` naturally.
5. Search notes locally.
6. Ask the AI sidebar about the current note and related notes using their own API key.
7. Back up their notes for free.
8. Open their note folder and see portable markdown files.

9. Save the current browser page into today's note with screenshot-backed BYOK AI enrichment.

The product should feel like Reflect's memory model survived, but the substrate became open, local, markdown-native, and AI-ready.
