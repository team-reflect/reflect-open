# Plan 14 — CLI (Read / Discovery)

**Goal:** A small read/discovery CLI over the graph — `reflect today`, `reflect search`,
`reflect show`, path lookup — so notes are scriptable and agent-friendly without a hosted
API.

**Depends on:** Plan 02 (graph), Plan 03 (doc model), Plan 04 (index). Reuses
`@reflect/core` (getters + markdown layer) and `@reflect/db`, plus the command-registry
concept from Plan 08.
**Unlocks:** `~/.agents` discovery workflows; terminal/automation access.

## Scope

**In:** read/discovery commands operating directly on the graph + `.reflect/` index;
plain + JSON output; graph resolution.
**Out:** a write CLI (manual markdown edits are the write path — explicitly no write CLI
first wave), Reflect-hosted endpoints, a long-running local server.

## Why read-only first

The product direction is deliberate: **read/discovery CLI first; manual markdown edits are
the write path.** Local servers and broader automation wait until the markdown, sync, and
permission model are clearer. Keeping the CLI read-only also sidesteps write races with the
desktop app's watcher (Plan 04).

## Architecture: a TS CLI that reuses the core

Per [Architecture & Conventions](architecture-conventions.md) the business logic is
TypeScript in `@reflect/core` — so the CLI is a **Node TS app at `apps/cli`** that imports
the same core getters + markdown layer, **not** a separate Rust binary. It does not need
the Rust process: it opens `.reflect/index.sqlite` **read-only** itself (e.g.
`better-sqlite3` + the Kysely dialect; FTS5 is compiled into SQLite for lexical search),
and uses the `@reflect/core` markdown layer for file-only operations.

## Steps

1. **CLI surface** (`apps/cli`, Node + TS, a `reflect` bin). Commands:
   - `reflect today` — print today's daily note (or its path with `--path`). File-only:
     resolve via the markdown layer + FS, no index needed.
   - `reflect search <query>` — lexical search over the read-only FTS index (Plan 04);
     ranked; `--json`; `--limit`.
   - `reflect show <note>` — print a note by id, title, or path (index lookup for id/title
     resolution, then read the file).
   - `reflect path <note>` — resolve a note to its absolute path (for piping into editors/
     tools).
   These mirror the documented set (`reflect search`, `reflect show`, `reflect today`,
   path lookup).

2. **Graph resolution.** Resolve the active graph from a flag (`--graph`), env var, or
   recent-graph config (Plan 02, OS app-config), in that order. Clear error if none.

3. **Read-only index + freshness.** Open `.reflect/index.sqlite` read-only (WAL, no
   writes). `today`/`show`/`path` need only the markdown layer + FS, so they're always
   correct even with no index. `search` depends on the FTS index; if it's missing or stale
   (file hashes/mtimes diverge from indexed rows), **warn** that results may be stale and
   suggest opening the desktop app to refresh — the CLI does not run the Rust indexer or
   mutate the DB. Never mutate notes.

4. **Output contracts.** Human-readable default; `--json` emits a zod-typed schema (shared
   with the export JSON shape from Plan 13 where sensible) so agents/scripts get stable
   structures.

5. **Agent discovery hook.** Keep output stable and documented so `~/.agents` prompt/
   command discovery (the chosen extensibility path, not a plugin API) can drive Reflect
   reads. Document the commands in the repo.

6. **Tests.** `today` prints/locates the right file with no index present; `search` ranks a
   known phrase; `show`/`path` resolve by id/title/path; `--json` validates against its
   schema; a stale index makes `search` warn (and still return index rows).

## Key decisions / contracts

- **Read-only CLI**; markdown edits are the write path.
- **TS, reuses `@reflect/core`** (no parser/index reimplementation, no Rust binary, no
  dependency on a running desktop app).
- **No DB writes from the CLI** — `today`/`show`/`path` work index-free; `search` reads the
  FTS index and warns when stale rather than rebuilding.
- **`--json` output is zod-stable** for agents/scripts.
- **No hosted endpoints, no long-running server** first wave.

## Acceptance criteria

- `reflect today`, `reflect search`, `reflect show`, `reflect path` work against a graph
  with no desktop app running.
- `today`/`show`/`path` succeed even when `.reflect/index.sqlite` is absent.
- A graph edited externally makes `search` warn about staleness; other commands stay
  correct.
- `--json` output validates against its schema.
- `pnpm --filter @reflect/cli typecheck` + targeted tests pass.

## Risks

- **Concurrent access** with a running desktop app (SQLite locking). Mitigate with WAL +
  read-only connections; no CLI writes means no lock contention.
- **Index staleness** producing wrong `search` answers. Mitigate by detecting divergence
  (hashes/mtimes) and warning; full refresh is a desktop-app responsibility.
- **Distribution** (how users get `reflect`). Decide in Plan 15: ship the Node bin with the
  app, optionally a standalone build (bun/pkg) and a Homebrew formula.
