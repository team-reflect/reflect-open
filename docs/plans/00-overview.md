# Reflect V2 — First-Version Implementation Roadmap

This directory holds the numbered, dependency-ordered plans for building the **first
version (first wave)** of Reflect V2: the open-source, local-first, markdown-native,
AI-native rewrite described in the product docs.

## Status at first release (2026-06-12)

The first macOS release ships Plans 01–10, 12, 14–17 (Plan 16 at its V1 scope: SSH +
path remotes; HTTPS credential helpers later). Two deliberate divergences:

- **Plan 11 (link capture) is deferred — the first release ships without the browser
  integration.** The design and [bridge spike](../spikes/link-capture-bridge.md) stand;
  the capture envelope/inbox architecture is unbuilt, and no extension exists yet.
- **Plan 13 (import/export) has not been built.** The graph is already a plain markdown
  folder (copyable, inspectable — the core portability promise holds), but the in-app
  import (Obsidian/markdown) and export (Markdown/JSON/HTML ZIP) surfaces are
  outstanding.

Two features landed beyond the written plans: **audio memos** (raw-first capture with
async BYOK cloud transcription — listed below as deferred, but shipped early via
`actions/audio-memo`), and **durable AI chat persistence** (the `chat_*` tables in
`index.sqlite` are the one sanctioned non-rebuildable exception to the
projection-only rule). The AI copilot (Plan 10) shipped **read-only** (chat over
local context); patchsets/edits remain a later wave, per the plan's revision note.

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
| 10 | [AI copilot sidebar](10-ai-copilot-sidebar.md) | BYOK provider, keychain secrets, context/retrieval, chat/summarize/rewrite, reviewable patchsets, `private: true` hard-block |
| 11 | [Link capture](11-link-capture.md) | **Deferred — not in the first release.** Chrome extension → native-messaging bridge → desktop write path, screenshots, BYOK enrichment, daily-note `[[Links]]` |
| 12 | [Backup & sync (GitHub-only)](12-backup-and-sync.md) | GitHub/Git backup + restore (the only supported remote), Git-native conflict surface, manual review, checkpoints; file-sync providers unsupported |
| 13 | [Import / export / portability](13-import-export-portability.md) | **Not started — outstanding at release.** Markdown/Obsidian-graph import, JSON/Markdown/HTML export, attachments preserved |
| 14 | [CLI (read/discovery)](14-cli-read-discovery.md) | `reflect today`, `reflect search`, `reflect show`, path lookup |
| 15 | [Hardening, packaging & OSS release](15-hardening-packaging-release.md) | a11y, perf budgets, signing/notarization, MIT + docs, onboarding, release pipeline |
| 16 | [Generic git remotes](16-generic-git-remotes.md) | Any git host (GitLab/Gitea/GHES/NAS) via hand-wired `origin`, zero new UI — V1 SSH (agent) + path remotes, V2 HTTPS (credential helpers) |
| 17 | [Readable filenames](17-readable-filenames.md) | Title-derived note filenames (slug + collision suffix), frontmatter `id` adoption, rename-on-settled-title file moves, id-healed external renames |
| 18 | [Tasks](18-tasks.md) | **Post-release add-on.** GFM-checkbox tasks as a rebuildable projection: interactive editor checkboxes, Tasks view (Overdue/Today/Upcoming), `[[date]]`/daily scheduling, guarded toggle write-back, `checklist: true` opt-out |
| 19 | [Mobile companion](19-mobile.md) | **Post-release add-on.** iOS (then Android) as a target of the existing Tauri app: today/daily browsing, in-place note editing, quick capture, new notes, lexical search, GitHub sync parity; shell decision in [TDR 0003](../decisions/0003-mobile-shell.md) |

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
- **M4 — Capture & durability** (Plans 11–13): link capture, backup/sync, import/export.
  *(Shipped partially: backup/sync landed; link capture was cut from the first release;
  import/export is unbuilt. Audio-memo capture shipped instead, ahead of plan.)*
- **M5 — Reach & release** (Plans 14–15): CLI, hardening, packaging, open-source launch.

## Dependency graph (abridged)

```text
01 ─┬─ 02 ─┬─ 03 ─┬─ 04 ─┬─ 05 ─ 06 ─┬─ 07 ─┬─ 08 ─ 09 ─ 10
    │      │      │      │           │      │
    │      │      │      └───────────┴──────┘  (index feeds backlinks + search)
    │      │      └─ 13 (import/export needs the doc model)
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
2. **A graph inside a cloud-sync folder corrupts the index and fights GitHub.** Remote
   sync is **GitHub-only** (file-sync providers are unsupported by design — Plan 12); but a
   user may still *place* their graph in iCloud/Dropbox, which can replace the SQLite
   `-wal`/`-shm` mid-write. Mitigation: detect cloud roots + warn/recommend a non-synced
   path, exclude `.reflect/`, and relocate the index to app-data as an escape hatch
   (Plan 04; detection in Plan 02).
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
- **Portable data + export from day one.** Backup must be free, via **GitHub only**;
  file-sync providers (iCloud/Dropbox/Drive) are unsupported for sync by design.
- **No Electron, no web app, Mac-first.** Tauri shell; iOS/Windows later.
- **MIT open-source core.** Write as if the code is public and will be critiqued. The
  editor [meowdown](https://github.com/prosekit/meowdown) is **first-party** (owned by the
  team) and MIT-licensed, so the MIT core holds with no copyleft constraint.

## Explicitly deferred (NOT first wave)

Do not build these now; keep the door open in the data model. Tasks (now planned as a
post-release add-on — [Plan 18](18-tasks.md)), link capture
(Plan 11 — designed, deferred from the first release), full browser clipper / article
extraction, graph-map view, templates,
contacts/calendar, publishing, any non-GitHub sync (iCloud/Dropbox/Drive are unsupported
by design, not "deferred"), a public plugin API, typed-entity layer, and full multi-device
sync conflict automation (incl. AI-assisted resolution). Mobile
did not block the Mac release and is now planned as a post-release add-on —
[Plan 19](19-mobile.md): capture/read/**edit**/lexical-search on iOS first (Tauri
mobile, per [TDR 0003](../decisions/0003-mobile-shell.md)), Android shortly after.

## Conventions (apply to every plan)

From [AGENTS.md](../../AGENTS.md): TypeScript with no `any`; zod at every data
boundary, normalized to camelCase; kebab-case files; one component per file;
providers + hooks for state; small single-responsibility modules; Kysely for DB types;
Tailwind + shadcn (`components/ui`) + Lucide; document all public APIs; run
`pnpm typecheck` and targeted `pnpm test --run` before declaring a phase done.
