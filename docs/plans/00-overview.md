# Reflect V2 — First-Version Implementation Roadmap

This directory holds the numbered, dependency-ordered plans for building the **first
version (first wave)** of Reflect V2: the open-source, local-first, markdown-native,
AI-native rewrite described in the product docs.

## Current source status (2026-06-14)

The source tree now implements Plans 01–12 and 14–17, with Plan 16 at its V1 scope
(SSH agent auth + path remotes; HTTPS credential helpers remain V2). Plan 11 is no
longer deferred: the repo contains the WXT extension (`apps/extension`), the native
messaging sidecar (`apps/native-host`), desktop capture commands
(`apps/desktop/src-tauri/src/capture.rs`), and the TS drain/enrichment path in
`@reflect/core`.

Plan 13 is **closed by product decision**: the graph folder itself is the portability
surface, so no dedicated import/export suite is planned. Reflect V1 exports now use a
V2-compatible markdown graph shape, so there is no separate V1 import surface. Plan 18
remains an unbuilt add-on. Plan 19 is active implementation work, not just a future
track: the existing Tauri app has a platform root gate, mobile UI tree, fixed-root
onboarding, target-gated Rust capabilities, and the first-party iOS keyboard plugin;
physical-device validation and App Store/TestFlight hardening are still open.

Two features landed beyond the original written plans: **audio memos** (raw-first
capture with async BYOK cloud transcription via `actions/audio-memo`) and **durable AI
chat persistence** (the `chat_*` tables in `index.sqlite` are the one sanctioned
non-rebuildable exception to the projection-only rule). The AI copilot (Plan 10) ships
as a dedicated, read-only chat view over local tools; patchsets/edits remain a later
wave, per the plan's revision note.

Read these alongside the source docs they implement:

- [V2 Product Vision](../reflect-v2-product-vision.md)
- [V2 Indexing Strategy](../reflect-v2-indexing-strategy.md)
- [V2 Sync Strategy](../reflect-v2-sync-strategy.md)
- [V2 Grounding Brief](../reflect-v2-grounding-brief.md)
- [V1 Overview](../reflect-v1-overview.md)
- Repo conventions: [AGENTS.md](../../AGENTS.md)

## How to read this set

Each plan is one phase. A phase has a **goal**, **depends on / unlocks**, **scope**
(explicit in/out), **steps**, **key decisions/contracts** (with code sketches),
**acceptance criteria**, and **risks**. Build them roughly in order — later phases
assume the contracts defined in earlier ones.

The product vision is explicit: **do not start with screens.** Start by defining
contracts (document model, workspace model, projection model, sync model, assistant
model, route model). The plan ordering reflects that — storage and the index land
before the editor, and the editor lands before search/AI.

> **Read first:** [Architecture & Conventions](architecture-conventions.md) — the
> cross-cutting decisions (Turborepo monorepo, **TS `core` / Rust primitives**, the
> per-domain **actions** pattern, full Kysely discipline) that every plan below assumes.
> Chosen libraries (TS + Rust) per step are recorded in [Libraries](libraries.md).

## The plans

| # | Plan | Delivers |
|---|------|----------|
| 01 | [Foundation & toolchain](01-foundation-and-toolchain.md) | Tauri/React/TS app shell, Tailwind + shadcn + Lucide, zod, Kysely wiring, test/lint, design-system, IPC conventions |
| 02 | [Graph & file storage](02-graph-and-file-storage.md) | Graph folder (`daily/`, `notes/`, `assets/`, `.reflect/`), Rust file IO, frontmatter + note identity, graph open/create |
| 03 | [Markdown document model](03-markdown-document-model.md) | Canonical AST, frontmatter + wiki-link parsing, lossless serialization, zod schemas, external-edit tolerance |
| 04 | [Local index (SQLite)](04-local-index-sqlite.md) | SQLite-in-Rust + Kysely query builder, projections, FTS, file watching, incremental indexing, rebuild/repair |
| 05 | [Markdown editor](05-markdown-editor.md) | Integrate **meowdown** (ProseKit/ProseMirror over `@lezer/markdown`), keyboard-native; add wiki-link/image/checkbox extensions |
| 06 | [Daily notes & routing](06-daily-notes-and-routing.md) | Opens to today, chronological navigation, `[[YYYY-MM-DD]]` date links, stable route model |
| 07 | [Backlinks](07-backlinks.md) | `[[` autocomplete, create-from-unresolved, incoming backlinks, rename-rewrite + aliases |
| 08 | [Lexical search & command palette](08-lexical-search-and-command-palette.md) | `⌘K` search/command surface, FTS over titles/body, filters, navigation commands |
| 09 | [Semantic search & local embeddings](09-semantic-search-and-embeddings.md) | Local embedding runtime (Rust), chunking, `sqlite-vec`, incremental re-embed, retrieval layer |
| 10 | [AI copilot sidebar](10-ai-copilot-sidebar.md) | BYOK providers, keychain secrets, read-only chat route over `search_notes`/`read_note`, durable chat history, `private: true` hard-block; patchsets deferred |
| 11 | [Link capture](11-link-capture.md) | Chrome extension → native-messaging sidecar → desktop capture inbox, screenshots, meta/BYOK enrichment, dedicated capture notes + daily-note `[[Links]]` |
| 12 | [Backup & sync (GitHub-only)](12-backup-and-sync.md) | GitHub/Git backup + restore, Git-native conflict surface, manual review, checkpoints. Written when file-sync providers were unsupported — Plan 21 later shipped iCloud Drive as the primary sync path; Git remains the self-managed alternative (never both on one graph) |
| 13 | [Import / export / portability](13-import-export-portability.md) | **Closed by decision.** Markdown files are the portability surface; no JSON/HTML/ZIP export or Obsidian/folder import suite is planned |
| 14 | [CLI (read/discovery)](14-cli-read-discovery.md) | `reflect today`, `reflect search`, `reflect show`, path lookup |
| 15 | [Hardening, packaging & OSS release](15-hardening-packaging-release.md) | a11y, perf budgets, signing/notarization, MIT + docs, onboarding, release pipeline |
| 16 | [Generic git remotes](16-generic-git-remotes.md) | Any git host (GitLab/Gitea/GHES/NAS) via hand-wired `origin`, zero new UI — V1 SSH (agent) + path remotes, V2 HTTPS (credential helpers) |
| 17 | [Readable filenames](17-readable-filenames.md) | Title-derived note filenames (slug + collision suffix), frontmatter `id` adoption, rename-on-settled-title file moves, id-healed external renames |
| 18 | [Tasks](18-tasks.md) | **Post-release add-on.** Round-checkbox (`+ [ ]`) tasks as a rebuildable projection: interactive editor checkboxes, Tasks view (Overdue/Today/Upcoming), `[[date]]`/daily scheduling, guarded toggle write-back, square checklists excluded |
| 19 | [Mobile companion](19-mobile.md) | **In progress.** iOS target of the existing Tauri app: mobile root gate, fixed graph root, onboarding, Daily/All shell, editable notes, keyboard plugin; device validation + store hardening remain |
| 20 | [Asset descriptions](20-asset-descriptions.md) | **Post-release add-on.** AI-generated `.reflect.md` description files for referenced, non-private images/PDFs under `assets/`; BYOK, privacy-gated, manual backfill |
| 21 | [iCloud Drive sync](21-icloud-drive-sync.md) | **Shipped (2026-07-04).** iCloud Drive as the primary consumer sync path: graphs in the app's iCloud container, deterministic resolution ladder over per-device shadow bases (markers as the fallback), `.reflect/`/`.git/` sync-exclusion, iCloud-first onboarding on both platforms with multi-graph lists + the mobile switcher; git remotes stay the self-managed path. AI-assisted resolution deferred |

## Milestone map

The phases group into shippable milestones. Each milestone is independently
demonstrable.

- **M0 — Walking skeleton** (Plans 01–02): app boots, user picks a graph folder, Rust
  reads/writes a markdown file round-trip.
- **M1 — Notes you can write** (Plans 03, 05, 06; index **04 can lag**): parser + editor +
  daily notes. *First genuinely usable build:* open today's note, write markdown, files
  land on disk, reopen. **Sequencing insight (review):** the editor and daily notes read/
  write files directly and **don't need the SQLite index** — only search/backlinks do. So
  ship M1 file-only with a no-op indexer, and land Plan 04 (the index) **with M2**, where
  it's actually needed. This shrinks M1 (which was overloaded) and de-risks the bespoke
  Kysely-over-IPC layer by not blocking "usable" on it.
- **M2 — A connected graph you can find** (Plans 07–09): backlinks, `⌘K` lexical
  search, then local semantic search.
- **M3 — AI-native** (Plan 10): the right-sidebar copilot over local context.
- **M4 — Capture & durability** (Plans 11–13): link capture, backup/sync, and the
  markdown-folder portability contract. *(Shipped substantially: backup/sync, link
  capture, and audio memos landed; Plan 13 is closed because the graph itself is the
  export.)*
- **M5 — Reach & release** (Plans 14–15): CLI, hardening, packaging, open-source launch.

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

The highest-severity risks surfaced reviewing this plan, with where they're handled:

1. **meowdown is the core bet and is early (v0.2.0, no wiki-links).** The whole product
   rides a pre-1.0 editor we must extend with `[[ ]]`. **Gate passed:** the Plan 01
   wiki-link spike confirmed lossless `[[ ]]` round-trips + a clean extension path
   ([docs/spikes/meowdown-wiki-links.md](../spikes/meowdown-wiki-links.md)). Residual: it's
   pre-1.0 (we own the extension code, pin versions); CodeMirror-6 live-preview stays the
   documented fallback. *Licensing is resolved — meowdown is first-party MIT.*
2. **A cloud-sync folder can corrupt the index or fight a Git remote.** Originally
   mitigated by refusing file-sync providers outright; since Plan 21 shipped, iCloud
   Drive is the *supported primary* path and the risk is managed instead of avoided:
   `.reflect/` (and `.git/`) are sync-excluded so the SQLite `-wal`/`-shm` never ride
   the provider, atomic-write temps stage inside `.reflect/tmp/`, and **iCloud and a
   Git remote are mutually exclusive per graph**. Third-party folder sync (Dropbox et
   al.) remains unsupported: same hazards, none of Plan 21's machinery.
3. **Durable macOS folder access** (TCC prompts; security-scoped bookmarks if sandboxed) —
   the in-graph decision depends on it; spike + handle in Plans 01/02/15.
4. **Bespoke Kysely-over-IPC dialect** is non-trivial; keep zod to real boundaries and keep
   a named-query-command fallback (Plan 04).
5. **Scope creep in sync/AI:** AI-assisted conflict resolution trimmed out of first wave
   (Plan 12); semantic search kept independently deferrable (Plan 09).

## First-wave scope guardrails

These are the product's hard principles. Every plan must hold them. Restated here so
they are not re-litigated per phase:

- **Markdown is the source of truth.** SQLite under `.reflect/` is a rebuildable
  projection, never durable storage. Any non-rebuildable local state must be justified.
- **No Reflect-hosted APIs.** LLM/transcription/sync calls go directly from the app to
  user-approved providers (BYOK AI providers, GitHub). No proxy through Reflect infra.
- **`private: true` is a hard block.** Such notes' content must never be sent to any
  external service — AI, capture enrichment, conflict resolution, or otherwise.
- **Secrets live in the OS keychain.** Never in markdown, Git, or `.reflect/`.
- **Keyboard-native.** Every core workflow reachable from the keyboard.
- **Portable data from day one.** The graph folder itself is the export; backup must be
  free. Sync is iCloud Drive (the primary path since Plan 21) or a Git remote — one per
  graph, never both; other file-sync providers (Dropbox/Drive) remain unsupported.
- **No Electron, no web app, Mac-first.** Tauri shell; iOS/Windows later.
- **MIT open-source core.** Write as if the code is public and will be critiqued. The
  editor [meowdown](https://github.com/prosekit/meowdown) is **first-party** (owned by the
  team) and MIT-licensed, so the MIT core holds with no copyleft constraint.

## Explicitly deferred (NOT first wave)

Do not build these now; keep the door open in the data model. Tasks (now planned as a
post-release add-on — [Plan 18](18-tasks.md)), full browser clipper / article
extraction beyond the implemented Plan 11 link-capture flow, graph-map view, templates,
contacts/calendar, publishing, any non-GitHub sync (iCloud/Dropbox/Drive are unsupported
by design, not "deferred"), a public plugin API, typed-entity layer, and full multi-device
sync conflict automation (incl. AI-assisted resolution). Mobile did not block the Mac
release, but [Plan 19](19-mobile.md) is now underway: capture/read/**edit**/lexical-search
on iOS first (Tauri mobile, per [TDR 0003](../decisions/0003-mobile-shell.md)), Android
shortly after.

## Conventions (apply to every plan)

From [AGENTS.md](../../AGENTS.md): TypeScript with no `any`; zod at every data
boundary, normalized to camelCase; kebab-case files; one component per file;
providers + hooks for state; small single-responsibility modules; Kysely for DB types;
Tailwind + shadcn (`components/ui`) + Lucide; document all public APIs; run
`pnpm typecheck` and targeted `pnpm test --run` before declaring a phase done.
