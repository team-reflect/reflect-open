# Reflect V2 Product Vision

The intended direction for Reflect V2: an open-source, local-first, markdown-native rewrite that keeps V1's strongest ideas while changing its architecture and parts of the product. Read it alongside:

- [Reflect V1 Overview](./reflect-v1-overview.md)
- [Reflect V2 Grounding Brief](./reflect-v2-grounding-brief.md)
- [Reflect V2 Indexing Strategy](./reflect-v2-indexing-strategy.md)
- [Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md)

## Product Thesis

Reflect V2 is a beautiful, local-first, AI-native markdown app for personal memory.

It keeps Reflect's core insight: people capture life chronologically, then understand it associatively. Daily notes stay the default capture surface, backlinks the organizing primitive, and search the recall layer. The change: V2 is built on open, inspectable, portable markdown files instead of an encrypted cloud-first database. It should feel like Reflect, but be easier to trust, extend, back up, and work with through AI.

## Principles To Preserve From V1

- **Daily notes first.** The app opens on today's note; quick text defaults there; past and future dailies are valid places to write; search and backlinks jump to dates naturally. The storage may be files, but the product stays daily-first.
- **Association over hierarchy.** Folders may exist because files live on a file system, but they are not the main abstraction. Notes link to notes, dailies link to people, projects, and events, incoming backlinks create context, and search and AI use links as memory structure.
- **Fast capture before organization.** Type immediately, backlink without leaving the keyboard, save the current browser page without choosing a filing system, search instantly, and ask the copilot without building a workflow.
- **Keyboard-native UX** is part of Reflect's identity: search, today's note, new note, backlinks, the AI sidebar, editor/sidebar focus, and AI edit review all need direct keyboard paths.
- **User-owned data.** Notes are real markdown files users can inspect, copy, back up, version, and edit with other tools. The local database is for performance; knowledge is never locked inside it.

## Major Departures From V1

- **Markdown is the source of truth.** V1 stores ProseMirror/Yjs documents and sync metadata. V2 stores markdown; indexes, backlinks, embeddings, and UI projections are rebuildable from files wherever possible.
- **No E2EE-first architecture.** An intentional shift: built-in E2EE would make search, semantic indexing, AI, open protocols, and simple backup harder. Privacy comes instead from local-first storage, user-controlled files, transparent BYOK AI calls, clear controls over what context reaches providers, and possibly optional encrypted backup later. V2 does not pretend cloud AI and universal E2EE are compatible: sending note context to a provider must be made clear.
- **No web app.** Desktop and mobile only: Mac first, iOS planned, Windows and Android possible later. This lets V2 lean into local files, native file access, local indexes, OS key storage, native menus, offline behavior, and backup integration.
- **No Reflect-hosted APIs.** LLM and transcription calls go directly to providers with user credentials. Backup and sync go directly to GitHub, Git, iCloud Drive, or local folders. Link enrichment does not use a hosted replacement for V1's link description API. Capture, indexing, AI context selection, writes, and conflict handling run locally. This is a hard trust and architecture principle, not a launch simplification: future business models must not assume Reflect operates note, AI, sync, capture, or link-description APIs for the core product.
- **No Electron.** Lower memory, strong file system integration, native-feeling UX, and a shared app/editor core.
- **Open-source core**, MIT-licensed: the app, storage format, editor behaviors, and protocol assumptions are inspectable and extensible. The business model is TBD.

## Lessons From Obsidian

Obsidian proves users trust a local markdown vault. The lesson is not to maximize plugins or configurability: open files create trust, and a coherent first-party intelligence layer can make those files feel alive.

Borrow:

- **Boring vault durability**: files and attachments stay useful outside Reflect.
- **Complete link ergonomics**: `[[Wiki Links]]`, markdown links, aliases, rename handling, heading links where practical, and reliable autocomplete.
- **Visible, minimal metadata**: frontmatter for identity, aliases, `private: true`, provenance, and small atomic metadata, not hidden database records.
- **Backlinks as ambient context** while writing, not only in search.
- **Recoverability** (sync state, history, deleted-file recovery, conflict review) in plain product language, even over Git.
- **User-shaped workflows** through open files, CLI discovery, and `~/.agents` prompt/command context instead of a broad plugin API.

Differ: Obsidian's AI is ecosystem-led and fragmented, with different plugins owning retrieval, embeddings, chat, editing, providers, and privacy. Reflect owns these as one coherent layer: one right-sidebar copilot with visible context; one privacy model (`private: true` hard-blocks cloud AI and transcription); one reviewed patchset model for edits; one retrieval layer shared by search, backlinks, and AI; one conflict flow where AI can propose merges but content conflicts stay reviewable; and one extensibility model (files, CLI, `~/.agents`). Users should never assemble an AI note system from plugins.

## Storage Model

### Markdown Files

- One note per file. Dailies at `daily/YYYY-MM-DD.md`. Regular notes Reflect creates go in `notes/`; an opened vault may already hold notes at its root or in visible nested folders, and those paths stay intact.
- Attachments in `assets/`, referenced with relative markdown links.
- Human-readable filenames; stable note IDs in frontmatter. Frontmatter only for metadata markdown cannot represent cleanly.

The layout must let users back up and edit the folder without Reflect, let the app rebuild its index from files, keep backlinks valid across renames where practical, and keep attachments as normal files, not database blobs.

Large binaries need GitHub backup guardrails: warn or limit, instead of making Git LFS or object storage a first-wave requirement.

### Local Database And Indexes

SQLite is the committed default for derived state (metadata, backlink graph, tags, dates, FTS, embeddings, AI context cache, file state, UI state), under an ignored `.reflect/` directory. It is a cache/projection; any non-rebuildable state must be deliberately justified. `.reflect/` keeps the workspace self-contained while keeping binary indexes, credentials, and transient state out of Git and file sync. See [Reflect V2 Indexing Strategy](./reflect-v2-indexing-strategy.md).

### File Semantics

- The markdown body is the primary content. `[[Wiki Links]]` are canonical backlinks; standard markdown links still work.
- YAML frontmatter holds stable identity and app metadata only when needed. Aliases may live there so backlinks survive renames and external edits.
- `private: true` locks a note from cloud AI: its content must never reach BYOK or cloud providers for chat, edits, conflict resolution, agents, or background context. It is not an encryption, backup, GitHub, or local-search privacy guarantee.
- The parser tolerates external edits; invalid or unknown frontmatter never makes a note unreadable.
- On rename, known backlinks are rewritten and the previous title is kept as an alias.

## Editor Vision

An exceptionally good WYSIWYG-feeling markdown editor: users write markdown and it renders beautifully in place, never like a plain textarea, while syntax stays portable. Backlinks autocomplete and render naturally; daily-note links feel first-class; headings, lists, quotes, code, tables, images, and checkboxes work. Opinionated, calm, fast, and minimal.

- **Backlinks**: `[[` creates links with autocomplete; unresolved links create notes; incoming backlinks show; renames don't break common links; aliases are supported. Standard markdown links serve external and file links; the app doesn't force wiki syntax.
- **Daily notes**: `daily/YYYY-MM-DD.md`, date derived from the path, no title frontmatter needed. `[[2026-06-08]]` is the first stable date-link contract; natural-language date links can come later.

## AI-Native Model

The primary AI interface is a right-sidebar note copilot, like Cursor's sidebar, that understands the current note and searches other local notes for context.

First-wave capabilities: chat about and summarize the current note, rewrite selections, generate reviewable edits, answer questions from local notes, suggest backlinks, and extract action items as text.

AI edits, including multi-note edits, are patchsets. Risky, destructive, or broad edits require review. Low-risk patchsets may auto-apply only after a local checkpoint and only with locked notes excluded.

### Context Model

Context: the current note and selection, incoming and outgoing backlinks, lexical and semantic search results, and user-selected notes. The user must be able to see what context is used, and sending note content to an external provider must be transparent. `private: true` notes may stay locally searchable and in local semantic retrieval, but their content never reaches BYOK or cloud providers or external agent tools.

### BYOK First

V2 starts with bring-your-own-key AI (as shipped: OpenAI, Anthropic, Google, and OpenRouter keys in the OS keychain), leaving room for other providers, local generative models, and agentic workflows. It never requires Reflect-operated AI infrastructure; calls go straight from the app to the provider. BYOK generative AI is separate from semantic search, which uses local embeddings.

Later agentic workflows may create and edit multiple notes, summarize periods, extract entities, generate reviews, suggest cleanup, and create tasks. The first wave only establishes the copilot and the context/search foundation.

## Search And Intelligence

Search is core: local lexical, title, backlink-aware, and semantic search, all usable as AI context. Embeddings are generated and stored locally; BYOK cloud embeddings are not a first-wave requirement. Search runs over markdown plus the local projection, tolerates external edits, and rebuilds when needed.

## Link Capture

> **Status:** Link capture is implemented for the desktop Chrome-extension path:
> extension → native-messaging host → capture inbox → desktop markdown/assets write →
> async BYOK enrichment. Safari/mobile share targets, full article clipping, and
> read-later state remain later work; [Plan 11](./plans/11-link-capture.md) is the
> current implementation contract.

Basic link capture is part of the daily-first capture spine, narrower than a full clipper. V1's shape is worth keeping (browser capture creates a link record, a client operation turns it into a link note, and the daily note gets a `[[Links]]` entry), but V1 also called a Reflect-hosted `link-description-api.vercel.app/describe` for summaries. V2 keeps the behavior and inverts the architecture:

- The Chrome extension captures URL, title, selection/highlights, and a screenshot, and sends them to the desktop app through a local bridge. It never stores provider keys.
- The desktop app owns all durable writes, paths, AI calls (BYOK description from URL, screenshot, title, and selection), keychain access, and privacy checks.
- The result is markdown and assets, indexed like any other content.

The bridge is an adapter, not a product assumption. Native messaging was the preferred first spike: it is Chrome's official extension-to-native channel and exposes no local HTTP port. Loopback HTTP stays a fallback for payload size, streaming, or packaging problems. A `reflect://` deep link is only a URL-only fallback (too limited for screenshots, metadata, retries, and errors). A Reflect-hosted relay is never used for the core path.

Saved shape: an entry under a `[[Links]]` section in today's daily note; a dedicated note when the description, highlights, or screenshot make it worth preserving; screenshots under `assets/`; and minimal provenance (URL, title, time, source, screenshot path, highlights, AI provider/model). If the note or capture is `private: true`, nothing goes to cloud AI; the raw link can still be saved locally.

## Platform Strategy

- **Mac first** means quality, file access, editor polish, and AI workflow quality over platform parity at launch, not Mac-only forever.
- **Mobile** need not block the first Mac release. It starts with capture into today's note, reading, lexical title/body/backlink search, and sync compatibility. Editor parity, local semantic search, heavy AI, and complex conflict review come after desktop proves the storage, sync, and indexing model.
- **Windows and Android** stay possible; avoid choices that rule them out, without optimizing for them early.

### Shell Spike

> **Resolved:** the spike happened and **Tauri 2 is the shipped desktop shell** (React/
> TypeScript frontend in a Rust native shell, with the `reflect` CLI bundled as a
> sidecar). The paragraph below is preserved as the original decision framing.

V2 should not commit to Tauri or a native Mac shell before a focused spike comparing them with the real editor, file access, SQLite/indexing, GitHub backup, keyboard behavior, and window/menu requirements.

## Backup And Sync Strategy

> **Status (2026-06-12):** the first release ships the Git adapter only: GitHub via
> device-flow auth, plus generic git remotes over SSH/path. File-sync folder providers
> (iCloud Drive/Dropbox/Drive) are **unsupported for sync by design** in the first wave
> (see Plan 12); the adapter list below is the long-term direction. AI-assisted conflict
> resolution did not ship: notes merge through one ladder, and other files keep a
> conflict copy.
>
> **Update (2026-07-04):** [Plan 21](./plans/21-icloud-drive-sync.md) shipped
> **iCloud Drive as the primary consumer sync path**: the app's own container,
> iCloud-first onboarding on macOS and iOS, and deterministic on-device conflict
> resolution (see [icloud-sync.md](./icloud-sync.md)). Git remains the
> self-managed adapter; a graph syncs via iCloud *or* a Git remote, never both.
> AI-assisted resolution stays deferred.

Backup must be free, understandable, and need no Reflect account or infrastructure. Sync uses an adapter pattern behind a stable internal interface. Git/GitHub is the first serious target but not an irreversible commitment. Candidate adapters: Git history, GitHub multi-device sync, local folder backup, iCloud Drive or OS file sync, Dropbox/Drive-style folders, and future protocols.

Keep three concepts apart: **backup** (the user can recover data), **sync** (devices converge safely), and **collaboration** (multiple users edit shared content). Hide adapter complexity: no commits, branches, rebases, or merge markers as product concepts, only plain language like "Backed up", "Syncing", "Offline". GitHub setup lets the user choose a repository instead of assuming Reflect creates one, while Reflect configures safe defaults, ignores, and recovery.

### Adapter-Normalized Conflict Resolution

Git conflicts, iCloud duplicates, local-folder conflicts, and future provider conflicts all become one Reflect conflict model before reaching the UI or AI. Git becomes more plausible as a sync layer when Reflect owns the conflict experience.

The explored AI flow: detect a conflict, parse the versions into a structured diff, have the copilot propose a merge preserving both sides' intent, show it as a reviewable patch the user can accept, edit, or reject, and keep the raw versions recoverable. It sits above the adapter so every adapter can reuse it. Note-body conflicts require review; automatic resolution stays limited to trivial non-content conflicts unless a later decision expands that boundary. See [Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md).

The first wave commits to backup, local ownership, and a sync adapter boundary; full sync can wait until the file format, conflict model, and mobile story are clearer.

## Feature Migration Matrix

### First-Wave V2 Features

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
| CLI                | Read/discovery commands such as `reflect search`, `reflect show`, `reflect today`, and path lookup. Markdown edits are the write path. |

### Deferred V1 Features

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

Start from the decisions above unless the direction changes. Defaults not stated elsewhere in this document:

- **Note identity**: readable filenames plus stable frontmatter IDs; backlinks resolve by stable identity, with rename rewrite plus aliases.
- **AI edits**: multi-note patchsets, checkpointed before application; unsafe edits require review.
- **Audio memos**: shipped as raw-first capture (the recording is the durable artifact), with async BYOK cloud transcription and `private: true` cloud-processing lockouts.
- **Extensions**: no public plugin API in the first wave; discover `~/.agents` prompt/command context only.
- **Secrets**: per-device OS keychain or secure storage; never markdown, Git, or `.reflect`.

## Open Questions

- How much Git complexity can be fully hidden from users?
- Which conflict edge cases need stricter review than the default content-conflict policy?
- How should mobile eventually access and mutate the same GitHub-backed workspace?
- Which safe multi-note AI patches can auto-apply without review? (The first release ships the copilot read-only; patchsets are a later wave.)
- What command/skill subset should `~/.agents` discovery expose inside Reflect?
- What business model, if any, belongs in the long-term product?
- What is the eventual V1 migration path?

## Definition Of Success

A user can:

1. Install a Mac app.
2. Open today's markdown daily note instantly.
3. Write in a beautiful markdown editor without thinking about files.
4. Create `[[Wiki Links]]` naturally.
5. Search notes locally.
6. Ask the AI sidebar about the current note and related notes using their own API key.
7. Back up their notes for free.
8. Open their note folder and see portable markdown files.
9. Save the current browser page into today's note with screenshot-backed BYOK AI enrichment.

Reflect's memory model survives, but the substrate becomes open, local, markdown-native, and AI-ready.
