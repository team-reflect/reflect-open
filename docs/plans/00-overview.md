# Reflect V2 — First-Version Implementation Roadmap

The numbered, dependency-ordered plans for the **first wave** of Reflect V2: the
open-source, local-first, markdown-native, AI-native rewrite described in the product docs.

## Current source status (2026-06-14)

The source implements Plans 01–12 and 14–17. Plan 16 is at its V1 scope (SSH agent auth +
path remotes; HTTPS credential helpers remain V2). Plan 11 is no longer deferred: the WXT
extension (`apps/extension`), native-messaging sidecar (`apps/native-host`), desktop
capture commands, and the TS drain/enrichment path all exist.

Plan 13 is **closed by product decision**: the graph folder is the portability surface.
Reflect V1 exports already use a V2-compatible markdown shape, so there is no V1 import
surface. Plan 18 is an unbuilt add-on. Plan 19 is active: platform root gate, mobile UI
tree, fixed-root onboarding, target-gated Rust capabilities, and the iOS keyboard plugin
exist; device validation and App Store/TestFlight hardening are open.

Two features landed beyond the written plans: **audio memos** (raw-first capture, async
BYOK transcription) and **durable AI chat persistence** (the `chat_*` tables are the one
sanctioned non-rebuildable exception to the projection-only rule). The copilot (Plan 10)
ships as a read-only chat view over local tools; patchsets remain a later wave.

Source docs: [V2 Product Vision](../reflect-v2-product-vision.md),
[V2 Indexing Strategy](../reflect-v2-indexing-strategy.md),
[V2 Sync Strategy](../reflect-v2-sync-strategy.md),
[V2 Grounding Brief](../reflect-v2-grounding-brief.md),
[V1 Overview](../reflect-v1-overview.md), repo conventions in [AGENTS.md](../../AGENTS.md).

## How to read this set

Each plan is one phase with goal, depends on / unlocks, scope, steps, key decisions,
acceptance criteria, and risks. Later phases assume earlier contracts.

The product vision says **do not start with screens**: define contracts first (document,
workspace, projection, sync, assistant, route). So storage and the index land before the
editor, and the editor before search/AI.

> **Read first:** [Architecture & Conventions](architecture-conventions.md) (Turborepo,
> **TS `core` / Rust primitives**, per-domain **actions**, Kysely discipline). Libraries
> per step: [Libraries](libraries.md).

## The plans

| # | Plan | Delivers |
|---|------|----------|
| 01 | [Foundation & toolchain](01-foundation-and-toolchain.md) | Tauri/React/TS shell, Tailwind + shadcn + Lucide, zod, Kysely, test/lint, IPC conventions |
| 02 | [Graph & file storage](02-graph-and-file-storage.md) | Graph folder (`daily/`, `notes/`, `assets/`, `.reflect/`), Rust file IO, note identity, graph open/create |
| 03 | [Markdown document model](03-markdown-document-model.md) | Canonical AST, frontmatter + wiki-link parsing, lossless serialization, external-edit tolerance |
| 04 | [Local index (SQLite)](04-local-index-sqlite.md) | SQLite-in-Rust + Kysely builder, projections, FTS, watching, incremental indexing, rebuild |
| 05 | [Markdown editor](05-markdown-editor.md) | **meowdown** (ProseKit over `@lezer/markdown`), keyboard-native; wiki-link/image/checkbox extensions |
| 06 | [Daily notes & routing](06-daily-notes-and-routing.md) | Opens to today, chronological navigation, date links, route model |
| 07 | [Backlinks](07-backlinks.md) | `[[` autocomplete, create-from-unresolved, backlinks, rename-rewrite + aliases |
| 08 | [Lexical search & command palette](08-lexical-search-and-command-palette.md) | `⌘K` search/command surface, FTS, filters, navigation commands |
| 09 | [Semantic search & local embeddings](09-semantic-search-and-embeddings.md) | Local embeddings (Rust), chunking, `sqlite-vec`, incremental re-embed, retrieval |
| 10 | [AI copilot sidebar](10-ai-copilot-sidebar.md) | BYOK, keychain secrets, read-only chat over `search_notes`/`read_note`, durable history, `private: true` block; patchsets deferred |
| 11 | [Link capture](11-link-capture.md) | Chrome extension → native-messaging sidecar → capture inbox, screenshots, enrichment, capture notes + daily `[[Links]]` |
| 12 | [Backup & sync (GitHub-only)](12-backup-and-sync.md) | Git backup + restore, conflict surface, checkpoints. Written when file-sync was unsupported; Plan 21 later made iCloud the primary path, Git the self-managed alternative (never both) |
| 13 | [Import / export / portability](13-import-export-portability.md) | **Closed by decision.** Markdown files are the portability surface |
| 14 | [CLI (read/discovery)](14-cli-read-discovery.md) | `reflect today`, `reflect search`, `reflect show`, path lookup |
| 15 | [Hardening, packaging & OSS release](15-hardening-packaging-release.md) | a11y, perf, signing/notarization, MIT + docs, onboarding, release pipeline |
| 16 | [Generic git remotes](16-generic-git-remotes.md) | Any git host via hand-wired `origin`, no new UI. V1: SSH agent + path; V2: HTTPS credential helpers |
| 17 | [Readable filenames](17-readable-filenames.md) | Title-derived filenames, frontmatter `id` adoption, rename-on-settled-title moves, id-healed external renames |
| 18 | [Tasks](18-tasks.md) | **Post-release add-on.** `+ [ ]` tasks as a projection: editor checkboxes, Tasks view, date scheduling, guarded write-back |
| 19 | [Mobile companion](19-mobile.md) | **In progress.** iOS target of the Tauri app; device validation + store hardening remain |
| 20 | [Asset descriptions](20-asset-descriptions.md) | **Post-release add-on.** AI `.reflect.md` descriptions for non-private assets; BYOK, manual backfill |
| 21 | [iCloud Drive sync](21-icloud-drive-sync.md) | **Shipped (2026-07-04).** Primary consumer sync: iCloud container graphs, resolution ladder over per-device shadow bases, `.reflect/`/`.git/` exclusion, iCloud-first onboarding; AI-assisted resolution deferred |
| 22 | [Mobile GitHub connect](22-mobile-github-connect.md) | **Implemented; device pass pending.** Connect flow for local iOS graphs; no new sync mechanism |
| 23 | [Mobile AI chat](23-mobile-ai-chat.md) | Plan 10 chat on iOS as a fourth tab, per-device BYOK, lexical-only `search_notes`; streaming spike gates the build |

## Milestone map

- **M0 — Walking skeleton** (01–02): app boots, picks a graph, round-trips a file.
- **M1 — Notes you can write** (03, 05, 06): *first usable build.* **Sequencing (review):**
  editor and dailies read/write files directly and **do not need the index**; only
  search/backlinks do. So M1 ships file-only with a no-op indexer and Plan 04 lands
  **with M2**. This shrinks M1 and keeps the Kysely-over-IPC layer off the critical path.
- **M2 — A connected graph you can find** (07–09).
- **M3 — AI-native** (10).
- **M4 — Capture & durability** (11–13). *(Shipped substantially; Plan 13 closed.)*
- **M5 — Reach & release** (14–15).

## Dependency graph (abridged)

```text
01 ─┬─ 02 ─┬─ 03 ─┬─ 04 ─┬─ 05 ─ 06 ─┬─ 07 ─┬─ 08 ─ 09 ─ 10
    │      │      │      │           │      │
    │      │      │      └───────────┴──────┘  (index feeds backlinks + search)
    │      │      └─ 13 (closed: markdown graph is the portability surface)
    │      └─ 11 (capture writes via the file/IO + daily-note contract)
    └─ 12 (GitHub-only backup/sync; thin internal seam, after M1)
14 (CLI) reuses 02+03+04.  15 (release) gates everything.
```

## Top risks (from plan review)

1. **meowdown is the core bet and was early** (v0.2.0, no wiki links). **Gate passed:**
   the Plan 01 spike confirmed lossless `[[ ]]` round-trips. Residual: pre-1.0 (we own the
   extension, pin versions); CodeMirror-6 live preview is the fallback. Licensing is
   resolved (first-party MIT).
2. **A cloud-sync folder can corrupt the index or fight a Git remote.** First mitigated by
   refusing file-sync providers; since Plan 21, iCloud is *supported* and the risk is
   managed: `.reflect/` and `.git/` are sync-excluded (so SQLite `-wal`/`-shm` never
   sync), atomic-write temps stage in `.reflect/tmp/`, and **iCloud and a Git remote are
   mutually exclusive per graph**. Other folder sync (Dropbox etc.) stays unsupported:
   same hazards, none of Plan 21's machinery.
3. **Durable macOS folder access** (TCC; bookmarks if sandboxed): Plans 01/02/15.
4. **Kysely-over-IPC dialect** is non-trivial: zod only at real boundaries, named-query
   fallback (Plan 04).
5. **Scope creep in sync/AI:** AI conflict resolution cut from the first wave (Plan 12);
   semantic search independently deferrable (Plan 09).

## First-wave scope guardrails

The product's hard principles, restated so they are not re-litigated per phase:

- **Markdown is the source of truth.** `.reflect/` SQLite is a rebuildable projection; any
  non-rebuildable state must be justified.
- **No Reflect-hosted APIs.** LLM/transcription/sync calls go straight to user-approved
  providers.
- **`private: true` is a hard block** for every external service.
- **Secrets live in the OS keychain.**
- **Keyboard-native.**
- **Portable data from day one.** The graph folder is the export; backup is free. Sync is
  iCloud Drive (primary since Plan 21) or a Git remote, one per graph; other file-sync
  providers stay unsupported.
- **No Electron, no web app, Mac-first.**
- **MIT open-source core.** [meowdown](https://github.com/prosekit/meowdown) is first-party
  MIT, so there is no copyleft constraint.

## Explicitly deferred (NOT first wave)

Keep the door open in the data model, but do not build: tasks (now
[Plan 18](18-tasks.md)), full clipper / article extraction beyond Plan 11, graph map,
templates, contacts/calendar, publishing, any non-GitHub sync (iCloud/Dropbox/Drive are
unsupported by design, not "deferred"), a public plugin API, typed entities, and full
multi-device conflict automation (incl. AI resolution). Mobile did not block the Mac
release, but [Plan 19](19-mobile.md) is underway: capture/read/**edit**/lexical search on
iOS first (Tauri mobile, per [TDR 0003](../decisions/0003-mobile-shell.md)), Android after.

## Conventions

Every plan follows [AGENTS.md](../../AGENTS.md).
