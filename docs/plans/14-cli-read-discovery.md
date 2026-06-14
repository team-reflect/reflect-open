# Plan 14 — CLI (Read / Discovery)

**Goal:** A small read/discovery CLI over the graph — `reflect today`, `reflect search`,
`reflect show`, path lookup — so notes are scriptable and agent-friendly without a hosted
API. Ships as a **self-contained Rust binary**, bundled with the desktop app as a Tauri
sidecar.

**Depends on:** Plan 02 (graph layout), Plan 03 (doc-model contracts), Plan 04 (index
schema). **Supersedes** the earlier decision (here and in
[Architecture & Conventions](architecture-conventions.md)) that the CLI would be a Node
TS app reusing `@reflect/core` — see "Architecture" below for why.
**Unlocks:** `~/.agents` discovery workflows; terminal/automation access; Plan 15 bundles
and distributes the binary.

## Scope

**In:** read/discovery commands operating directly on the graph's markdown files and the
`.reflect/index.sqlite` projection; plain + JSON output; graph resolution (flag → env →
cwd); Cargo workspace bootstrap; Tauri sidecar bundling.
**Out:** a write CLI (manual markdown edits are the write path — explicitly no write CLI
first wave), Reflect-hosted endpoints, a long-running local server, shell completions/man
pages (nicety, later), Homebrew/standalone distribution and the in-app "Install CLI
command" action (Plan 15), a recents-based graph fallback (see "Graph resolution").

## Why read-only first

The product direction is deliberate: **read/discovery CLI first; manual markdown edits are
the write path.** Local servers and broader automation wait until the markdown, sync, and
permission model are clearer. Keeping the CLI read-only also sidesteps write races with the
desktop app's watcher (Plan 04): the CLI never takes a write lock on the index and never
mutates notes.

## Architecture: a self-contained Rust binary

The CLI is a **Rust crate at `apps/cli`** (package `reflect-cli`, binary **`reflect`**)
that reads the graph's markdown files itself and opens `.reflect/index.sqlite` itself —
no Node runtime, no running desktop app, no IPC.

Why Rust here, despite the "business logic lives in TS core" rule
([Architecture & Conventions](architecture-conventions.md) §2):

- **Self-contained distribution.** A single static binary (rusqlite `bundled` compiles
  SQLite + FTS5 in) with no runtime dependency. The Node alternative needs a Node install
  or a pkg/bun standalone build, and `node:sqlite`'s FTS5 support was an open risk.
- **Tauri's blessed bundling path is binary-shaped.** Tauri 2 sidecars
  (`bundle.externalBin`) bundle, sign, and notarize native executables for free — a Rust
  workspace crate slots straight in.
- **Same SQLite everywhere.** Desktop and CLI pin the same `rusqlite`/SQLite via one
  workspace lockfile, so there is no FTS5/version skew between writer and reader.
- **The CLI needs only the read-side contract**, which is small and stable: path
  conventions, fold keys, frontmatter reads, hash/staleness comparison, and a handful of
  SQL queries. Duplicating that thin layer in Rust is cheaper than dragging a JS runtime
  into distribution.

The cost is deliberate, bounded duplication: the read-side contract exists in TS
(`@reflect/core`) and now also in Rust. It is guarded by **parity tests** (below) and
documented as a frozen contract; the CLI must never grow its own parser/indexer beyond it.

### Workspace & crate layout

There is no Cargo workspace today (single crate at `apps/desktop/src-tauri`). This plan
creates one:

```text
reflect-open/
├── Cargo.toml                  # [workspace] members; resolver = "2"; root Cargo.lock
├── apps/
│   ├── desktop/src-tauri/      # existing app crate (reflect-open) — joins the workspace
│   └── cli/                    # NEW: package `reflect-cli`, [[bin]] name = "reflect"
└── crates/
    └── index-schema/           # NEW: shared schema crate (see below)
```

- **`crates/index-schema`** owns what desktop and CLI genuinely share: the
  `migrations/*.sql` files (moved from `apps/desktop/src-tauri/migrations/`), the
  `Migrations` list + `open_and_migrate`, the sqlite-vec auto-extension registration
  (feature-gated `vec`, default on), and a `LATEST_SCHEMA_VERSION` constant. Desktop's
  `db/migrations.rs` shrinks to a thin re-export. The CLI depends on it
  `default-features = false` for the version constant only, plus as a **dev-dependency
  with `vec`** to build fixture indexes in tests (migrations 0002/0003 create `vec0`
  tables, so fixture creation needs the module; the CLI runtime never touches embedding
  tables and never links sqlite-vec).
- `packages/db/scripts/generate-schema.mjs` line 22 points at the old migrations dir —
  update it to `crates/index-schema/migrations` (CI's codegen-drift check keeps working).
- Mechanics: root `Cargo.lock` replaces `apps/desktop/src-tauri/Cargo.lock`; add `/target`
  to the root `.gitignore`; CI's Rust job moves to the repo root
  (`cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`; `rust-cache` `workspaces: .`; the ort cache key's
  `hashFiles(...)` re-points at the root lockfile).
- `apps/cli` gets **no `package.json`** — it is driven by cargo/CI's Rust job, like
  `src-tauri` today, not by turbo (which would re-run cargo in the Node CI job).

**Crates** (additions recorded in [Libraries](libraries.md)): `clap` v4 derive (command
framework), `rusqlite` bundled (read-only index access), `jiff` (local "today",
tz/DST-correct), `sha2` (SHA-256 content hashes, matching the TS indexer), `saphyr`
(tolerant YAML frontmatter reads; `serde_yaml` is unmaintained), `pulldown-cmark`
(first-H1 title fallback — code-fence-safe, no hand-rolled scanning).

## Graph resolution

Resolve the active graph in this order; first hit wins, clear error if none:

1. `--graph <path>` (global flag),
2. `REFLECT_GRAPH` env var,
3. **walk up from the current directory** (git-style) to the nearest directory containing
   `.reflect/`.

A directory *is* a graph iff it contains `.reflect/` (the Plan 02 bootstrap contract; its
`meta.json` carries `schemaVersion`). An explicit `--graph`/env path that is not a graph
errors with that hint rather than falling through. **Deliberately no recents-config
fallback** (`recent-graphs.json` from Plan 02): the CLI must be deterministic for
scripts/agents and self-contained from desktop app-config; a `reflect graphs` discovery
command can revisit this later.

## The two read layers

**File layer** (always available; no index required):

- Path conventions mirrored from `packages/core/src/graph/paths.ts`: `daily/YYYY-MM-DD.md`
  (calendar-validated), `notes/<slug>.md`; only `daily/` + `notes/` are note dirs.
- Tolerant frontmatter read (title, `aliases`, `private` only): a broken YAML block
  degrades to "no frontmatter", matching the TS layer's tolerance. Read-only — the CLI
  never writes, so no round-trip machinery.
- Title derivation, matching `buildIndexedNote`: frontmatter `title` → first H1 →
  filename stem; a daily's title is its date.
- Fold keys matching `foldKey` (trim + lowercase) for title/alias matching.

**Index layer** (`.reflect/index.sqlite`, used by `search` and to accelerate `show`/`path`):

- Open **read-only** (`SQLITE_OPEN_READ_ONLY`, `PRAGMA query_only=ON` belt-and-braces,
  `busy_timeout` ~2s to coexist with the desktop writer; the DB is WAL). If a read-only
  open fails because the WAL needs recovery (possible after an unclean app exit), fall
  back to file-only behavior with a warning instead of failing the command.
- **Schema guard:** compare `PRAGMA user_version` to `index-schema`'s
  `LATEST_SCHEMA_VERSION`. Newer than the CLI → warn ("index is newer than this CLI;
  update Reflect") and still attempt the stable query subset: `notes`, `aliases`,
  `note_keys`, `search_fts`, `index_meta`. Never touch `embedding_*`/vec tables (the vec0
  module is not loaded; querying them would error).
- **Staleness detection** (drives the `search` warning): walk `daily/`+`notes/` `.md`
  files and compare against `notes` rows — a file missing from the index, an indexed path
  missing on disk, or (for mtime mismatches only) a SHA-256 content hash ≠ `file_hash`
  marks the index stale. The hash matches the indexer's (lowercase-hex SHA-256,
  `packages/core/src/indexing/hash.ts`), but the mtime gate is deliberately **cheaper
  than the desktop's `reconcileIndex`**, which reads and hashes every file on open. This
  check runs on every `search` invocation, so hashing whole graphs each time is too slow;
  the accepted cost is that an external edit that *preserves* a file's mtime goes
  unwarned (the desktop reconcile still catches it). Acceptable for an advisory warning —
  the gate exists because the reverse case (sync providers rewriting mtimes without
  content changes) must not produce false stale warnings, which the hash confirm handles.

## Commands

Global flags: `--graph <path>`, `--json`. **stdout carries only data; warnings and
errors go to stderr** so piped/JSON output stays clean. Exit codes:
`0` ok · `1` runtime error · `2` usage (clap) · `3` not found / private ·
`4` index missing or unusable (`search` only).

- **`reflect today [--path]`** — print today's daily note (local date via `jiff`).
  File-only; no index needed. `--path` prints the absolute path **even if the file does
  not exist yet** (dailies are created lazily — lets editors/scripts create it); without
  `--path`, a missing daily is exit 3.
- **`reflect search <query> [--limit N=20]`** — lexical search over the FTS index.
  Build the `MATCH` expression exactly like `buildFtsMatch` (each whitespace-split term
  double-quoted, embedded quotes doubled; empty query → empty result), rank exactly like
  the desktop's palette search: **title-boosted bm25** (`bm25(search_fts, 0, 10.0, 1.0)`,
  `packages/core/src/indexing/filtered-search.ts`), snippet via FTS5 `snippet()` on the
  body column. Private notes are excluded **twice**: the index filter
  (`notes.is_private = 0`) *and* a frontmatter re-read of every hit's file before
  emission — so a note flagged private after the last index run never reaches stdout
  even from a stale row (same file-over-index rule as `show`). A stale index
  **warns on stderr and still returns rows** (and sets `"stale": true` in JSON); a
  missing/unopenable index is exit 4 with "open the graph in Reflect to build the index" —
  the CLI never runs the indexer or mutates the DB.
- **`reflect show <note>`** — resolve and print a note. Resolution order mirrors
  `resolveWikiLink` plus a path convenience: calendar-valid `YYYY-MM-DD` → daily; exact
  graph-relative (or in-graph absolute) path; title fold-key; alias fold-key. Index-backed
  when the index is present (`notes.title_key` / `aliases.alias_key`, `ORDER BY path
  LIMIT 1` for deterministic collisions, others noted on stderr); **file-scan fallback**
  (derive titles/aliases per the file layer) when it is absent.
- **`reflect path <note>`** — resolve to an absolute path and print it (for piping into
  editors/tools). A `YYYY-MM-DD` argument prints the would-be daily path like
  `today --path`.

### Privacy

`private: true` is a hard block, and the CLI is explicitly an agent surface — its stdout
routinely ends up in LLM prompts. So **the CLI never returns private notes, with no
override flag**: `search` excludes them entirely; `show`/`today`/`path` on a private note
print nothing to stdout, explain on stderr ("note is private"), and exit 3. Private notes
are simply invisible through this surface — anyone who wants their content opens the file
or the app directly. The check reads the frontmatter of the resolved file itself (not just
the index row) — and `search` re-reads each hit's file the same way — so a just-flagged
note is blocked even when the index is stale or absent.

### Output contracts

`--json` emits stable serde-serialized camelCase shapes, documented in `docs/cli.md` and
locked by snapshot tests (the Rust analog of the original zod contract; share field names
with markdown frontmatter where sensible):

```jsonc
// today / show
{ "date": "2026-06-11", "path": "daily/2026-06-11.md", "absolutePath": "/…",
  "title": "2026-06-11", "content": "…" }
// search
{ "query": "…", "stale": false,
  "results": [ { "path": "notes/foo.md", "title": "Foo", "snippet": "…", "score": -1.5 } ] }
// path
{ "path": "notes/foo.md", "absolutePath": "/…", "exists": true }
```

## Tauri sidecar bundling (the blessed path)

Tauri 2's first-party mechanism for shipping a CLI with the app is
[`bundle.externalBin`](https://v2.tauri.app/develop/sidecar/) (sidecars). Verified
specifics, and how we wire it:

- **Config:** `"externalBin": ["binaries/reflect"]` — placed in **desktop platform
  overlay configs** (`tauri.macos.conf.json`, `tauri.windows.conf.json`,
  `tauri.linux.conf.json`), not the shared `tauri.conf.json`, because sidecars are
  unsupported on iOS/Android and the bundle currently targets iOS too.
- **Naming:** the on-disk file must be triple-suffixed —
  `src-tauri/binaries/reflect-<target-triple>[.exe]`; Tauri strips the suffix when
  copying it next to the app binary. A sidecar may not share the app **crate's package
  name** (`reflect-open`), so `reflect` is safe.
- **Build hook (there is no first-party Rust-sidecar build integration):**
  `apps/desktop/scripts/build-sidecar.mjs`, prepended to `beforeDevCommand` *and*
  `beforeBuildCommand` (tauri-build requires the file to exist before the app crate
  compiles, **dev included**). It: no-ops when `TAURI_ENV_PLATFORM` is ios/android;
  resolves the triple from `TAURI_ENV_TARGET_TRIPLE` (set by Tauri for before-commands),
  falling back to `rustc --print host-tuple`; runs
  `cargo build --release -p reflect-cli --target <triple>` — the **explicit `--target`
  matters**: it keeps the artifact in `target/<triple>/release/`, away from
  `target/release/` where tauri-build copies the de-suffixed sidecar (a known
  overwrite clash), and is what makes cross-compilation work; then copies the artifact to
  `binaries/reflect-<triple>[.exe]` (the `binaries/` dir is gitignored).
- **Where it lands:** macOS `Reflect.app/Contents/MacOS/reflect`; Windows NSIS
  `$INSTDIR\reflect.exe`; Linux `.deb` `/usr/bin/reflect` (**on PATH for free**);
  AppImage internal-only (documented limitation).
- **Signing:** free on macOS — Tauri signs sidecars inside-out with the hardened runtime
  (default-on) before signing the bundle, so notarization (Plan 15) covers the CLI with
  zero extra steps. One Plan 15 note: `--target universal-apple-darwin` builds need the
  fat sidecar `lipo`'d manually (Tauri only lipo's the main binary).
- **Permissions:** none — bundling alone needs no capability. (Only if the app itself
  ever spawns the CLI would it need `tauri-plugin-shell` + a `shell:allow-execute`
  sidecar scope entry.)
- **PATH for users:** Linux deb is automatic; macOS gets a VS-Code-style "Install
  `reflect` command" in-app action (symlink `Contents/MacOS/reflect` →
  `/usr/local/bin`, admin-prompted) and/or Homebrew in **Plan 15**; Windows via an NSIS
  `installerHooks` PATH entry, also Plan 15. Until then, `cargo install --path apps/cli`
  is the dev install.

## Steps

1. **Workspace bootstrap.** Root `Cargo.toml` workspace (members: `apps/desktop/src-tauri`,
   `apps/cli`, `crates/index-schema`); move the lockfile to the root; gitignore `/target`;
   update CI's Rust job (root cwd, `--workspace` flags, cache paths).
2. **Extract `crates/index-schema`.** Move `migrations/*.sql` + the migration/open/vec
   code; desktop re-exports; expose `LATEST_SCHEMA_VERSION`; re-point
   `generate-schema.mjs`; desktop tests + CI codegen check stay green.
3. **CLI scaffold** (`apps/cli`): clap surface (`today`/`search`/`show`/`path` + global
   flags), graph resolution (flag → env → cwd walk-up), error type → exit-code mapping,
   stdout/stderr contract.
4. **File read layer:** path conventions, tolerant frontmatter (title/aliases/private),
   title derivation, fold keys — with **parity tests** asserting the same
   inputs→outputs as the TS layer's tests (shared expected values for titles, keys, and
   SHA-256 hashes; a comment in each points at its counterpart).
5. **Index read layer:** read-only open + busy timeout + WAL-recovery fallback, schema
   guard, staleness detector.
6. **Commands** wired end-to-end: privacy gating, JSON output structs, snippets/ranking
   for `search`.
7. **Sidecar bundling:** `build-sidecar.mjs`, platform overlay configs, hook wiring;
   verify `pnpm tauri dev` still works and `pnpm tauri build` produces a bundle
   containing a runnable `reflect`.
8. **Docs:** `docs/cli.md` — commands, flags, exit codes, JSON schemas, the agent
   discovery hook (`~/.agents` workflows drive Reflect reads through these stable
   outputs). Update [Libraries](libraries.md) + the Plan 14 consequence in
   [Architecture & Conventions](architecture-conventions.md) (done alongside this plan).
9. **Tests.** `today` prints/locates the right file with no index present; `search` ranks
   a known phrase against a fixture index (built via `index-schema` migrations + direct
   row inserts) and excludes a private note; `show`/`path` resolve by date/title/alias/
   path with and without an index; an externally-edited fixture makes `search` warn
   stale (and still return rows); `--json` snapshots; a private note is absent from
   `search` results and `show`/`today`/`path` on it exit 3 — including when the privacy
   flag is newer than the index; parity tests from step 4.

## Key decisions / contracts

- **Read-only CLI**; markdown edits are the write path. No DB writes, no indexer runs —
  `search` warns on staleness rather than rebuilding.
- **Rust binary, not Node TS** (supersedes the prior decision): self-contained
  distribution + Tauri sidecar bundling outweigh TS-core reuse for a read-only surface.
  The duplicated read-side contract is frozen, tiny, and parity-tested.
- **Graph = nearest `.reflect/`**: flag → env → cwd walk-up; **no desktop-config
  fallback**.
- **`private: true` notes are invisible to the CLI** — excluded from `search`, refused by
  `show`/`today`/`path` (exit 3), **no override flag**; the resolved file's own
  frontmatter is checked, never just the index row.
- **stdout is data, stderr is diagnostics**; documented exit codes; `--json` shapes are
  stable and snapshot-locked.
- **One workspace lockfile** pins the same rusqlite/SQLite for app and CLI.
- **Sidecar via `bundle.externalBin`** in desktop-only platform configs; sidecar build is
  a before-command script with an explicit `--target`.

## Acceptance criteria

- `cargo build -p reflect-cli` yields a single self-contained `reflect`; `today`,
  `search`, `show`, `path` work against a graph with no desktop app running, resolved
  from the cwd by default or `--graph`/`REFLECT_GRAPH` explicitly.
- `today`/`show`/`path` succeed with `.reflect/index.sqlite` absent; `search` exits 4
  with a helpful message.
- A graph edited externally makes `search` warn stale (stderr + `"stale": true`) while
  still returning index rows; other commands stay correct.
- Private notes are never returned by any command — no content, no paths, no search hits;
  there is no flag that overrides this.
- `--json` output matches the documented schemas (snapshot tests); parity tests pin the
  TS↔Rust contract.
- `pnpm tauri build` bundles a signed, runnable `reflect` sidecar; `pnpm tauri dev` and
  iOS builds are unaffected.
- `cargo fmt`/`clippy`/`test --workspace` and the existing `pnpm check` + codegen-drift
  CI all pass.

## Risks

- **TS↔Rust contract drift** (title derivation, fold keys, hash, FTS match syntax) —
  wrong `show`/`search` answers that tests on either side alone wouldn't catch. Mitigate:
  parity tests with shared expected values; keep the duplicated surface minimal and
  cross-referenced. (JS `toLowerCase` vs Rust `to_lowercase` differ on a few Unicode
  edge cases — covered by a parity case, documented as acceptable.)
- **Concurrent access** with a running desktop app: WAL + read-only + busy timeout means
  no lock contention; the WAL-recovery read-only edge falls back to file-only with a
  warning.
- **Schema evolution**: a newer app may bump `user_version`/projection ahead of an
  installed CLI. The schema guard + stable query subset keeps old CLIs degrading
  gracefully (warn, not crash).
- **Mobile bundling regressions** from `externalBin` — mitigated by platform overlay
  configs; verified explicitly in step 7.
- **Workspace migration fallout** (CI caches, codegen path, tauri-cli target discovery).
  Step 1/2 land first and independently green before the CLI itself.
