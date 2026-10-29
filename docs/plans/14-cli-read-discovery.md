# Plan 14 — CLI (Read / Discovery)

**Goal:** A small read/discovery CLI over the graph (`reflect today`, `reflect search`,
`reflect show`, path lookup) so notes are scriptable and agent-friendly without a hosted
API. Ships as a **self-contained Rust binary**, bundled with the desktop app as a Tauri
sidecar. As-built user docs: [docs/cli.md](../cli.md).

**Depends on:** Plan 02 (graph layout), Plan 03 (doc-model contracts), Plan 04 (index
schema). **Supersedes** the earlier decision (here and in
[Architecture & Conventions](architecture-conventions.md)) that the CLI would be a Node
TS app reusing `@reflect/core`; see "Architecture".
**Unlocks:** `~/.agents` discovery workflows; terminal/automation access; Plan 15
distribution.

## Scope

**In:** read/discovery commands over the Markdown files and `.reflect/index.sqlite`;
plain + JSON output; graph resolution; Cargo workspace bootstrap; sidecar bundling.
**Out:** a write CLI (manual Markdown edits are the write path), hosted endpoints, a
local server, shell completions/man pages, Homebrew/standalone distribution and the
in-app "Install CLI command" action (Plan 15), a recents-based graph fallback.

## Why read-only first

The product direction is deliberate: **read/discovery CLI first; manual Markdown edits
are the write path.** Local servers and broader automation wait until the Markdown,
sync, and permission model are clearer. Read-only also sidesteps write races with the
desktop watcher: the CLI never takes a write lock and never mutates notes.

## Architecture: a self-contained Rust binary

The CLI is a Rust crate at `apps/cli` (binary **`reflect`**) that reads Markdown and
opens the index itself: no Node runtime, no running app, no IPC. Why Rust, despite "business
logic lives in TS core":

- **Self-contained distribution:** one binary with SQLite + FTS5 compiled in. Node needs
  an install or a standalone build, and `node:sqlite`'s FTS5 support was an open risk.
- **Tauri sidecars are binary-shaped:** `bundle.externalBin` bundles, signs, and
  notarizes native executables for free.
- **Same SQLite everywhere:** one workspace lockfile pins the same rusqlite for writer
  and reader, so no FTS5/version skew.
- **The CLI needs only the read-side contract** (path conventions, fold keys,
  frontmatter reads, hash comparison, a few SQL queries), which is small and stable.
  Duplicating it is cheaper than shipping a JS runtime.

The cost is deliberate, bounded duplication, guarded by **parity tests** and documented
as a frozen contract: the CLI must never grow its own parser/indexer beyond it.

### Workspace

This plan created the root Cargo workspace (`apps/desktop/src-tauri`, `apps/cli`,
`crates/index-schema`). `crates/index-schema` owns what desktop and CLI share: the
migrations, open-and-migrate, sqlite-vec registration (feature `vec`), and
`LATEST_SCHEMA_VERSION`. The CLI uses it without `vec` at runtime (it never touches
embedding tables or links sqlite-vec) and with `vec` only as a dev-dependency, because
fixture indexes need the `vec0` module the migrations create. `apps/cli` has **no
`package.json`**: cargo/CI's Rust job drives it, not turbo (which would re-run cargo in
the Node job).

**Crates** ([Libraries](libraries.md)): `clap`, `rusqlite` bundled, `jiff` (tz/DST-correct
local "today"), `sha2` (matches the TS indexer's hashes), `saphyr` (tolerant YAML;
`serde_yaml` is unmaintained), `pulldown-cmark` (code-fence-safe first-H1 fallback).

## Graph resolution

First hit wins: `--graph <path>`, then `REFLECT_GRAPH`, then **walk up from the cwd**
(git-style) to the nearest directory containing `.reflect/` (the Plan 02 graph
marker). An explicit path that is not a graph errors instead of falling through.
**Deliberately no recents fallback:** the CLI must be deterministic for scripts/agents and
independent of desktop app-config. A `reflect graphs` command can revisit this.

## The two read layers

**File layer** (no index needed): path conventions, tolerant frontmatter (a broken YAML
block degrades to "no frontmatter", like TS), title derivation (frontmatter `title` →
first H1 → filename stem; a daily's title is its date), and fold keys, all mirroring the
TS layer. Read-only, so no round-trip machinery.

**Index layer** (for `search`, and to speed up `show`/`path`):

- Open **read-only** with a busy timeout to coexist with the WAL desktop writer. If the
  WAL needs recovery (after an unclean app exit), fall back to file-only with a warning
  instead of failing.
- **Schema guard:** an index newer than the CLI warns ("update Reflect") and still tries
  the stable query subset. Never touch embedding/vec tables (the module is not loaded).
- **Staleness detection** drives the `search` warning: files missing from the index,
  indexed paths missing on disk, or, for mtime mismatches only, a content hash that
  differs. The mtime gate is deliberately **cheaper than desktop reconcile**, which
  hashes every file on open: this runs on every `search`, so hashing whole graphs is too
  slow. Accepted cost: an external edit that preserves mtime goes unwarned (desktop
  reconcile still catches it). The hash confirm exists so sync providers that rewrite
  mtimes without content changes do not cause false warnings.

## Commands

**stdout carries only data; warnings and errors go to stderr**, so piped/JSON output
stays clean. Exit codes: `0` ok, `1` runtime error, `2` usage, `3` not found / private,
`4` index missing or unusable (`search` only).

- **`today [--path]`**: file-only. `--path` prints the path **even if the daily does not
  exist yet** (dailies are lazy, so scripts can create it); without it a missing daily
  is exit 3.
- **`search <query>`**: FTS match and ranking built **exactly like the desktop palette**
  (title-boosted bm25) so results agree. A stale index **warns and still returns rows**
  (`"stale": true` in JSON); a missing index is exit 4 ("open the graph in Reflect to
  build the index"). The CLI never runs the indexer or mutates the DB.
- **`show <note>`**: resolution mirrors wiki-link resolution plus paths: valid
  `YYYY-MM-DD` → daily, exact path, title key, alias key. Collisions resolve
  deterministically (first path), others noted on stderr. File-scan fallback without an
  index.
- **`path <note>`**: absolute path for piping into tools; a date prints the would-be
  daily path like `today --path`.

### Privacy

`private: true` is a hard block, and the CLI is explicitly an agent surface whose stdout
routinely ends up in LLM prompts. So **the CLI never returns private notes, with no
override flag**: `search` excludes them; `show`/`today`/`path` print nothing, explain on
stderr, and exit 3. Anyone who wants the content opens the file or app. The check
re-reads the resolved file's frontmatter (and `search` re-reads each hit's file), never
just the index row, so a just-flagged note is blocked even when the index is stale or
absent.

### Output contracts

`--json` emits stable camelCase shapes, documented in [docs/cli.md](../cli.md) and
locked by snapshot tests (the Rust analog of the zod contract), sharing field names with
frontmatter where sensible.

## Tauri sidecar bundling

Tauri 2's first-party path is [`bundle.externalBin`](https://v2.tauri.app/develop/sidecar/).
Decisions and traps:

- `externalBin` goes in the **desktop platform overlay configs**, not the shared config,
  because sidecars are unsupported on iOS/Android and the bundle targets iOS too.
- The file must be triple-suffixed (`binaries/reflect-<triple>`); Tauri strips the suffix.
  A sidecar may not share the app crate's package name (`reflect-open`), so `reflect` is
  safe.
- No first-party Rust-sidecar build exists, so `apps/desktop/scripts/build-sidecar.ts`
  runs in `beforeDevCommand` *and* `beforeBuildCommand` (tauri-build needs the file
  before the app crate compiles, **dev included**) and no-ops on mobile. The **explicit
  `--target` matters**: it keeps the artifact in `target/<triple>/release/`, away from
  `target/release/` where tauri-build copies the de-suffixed sidecar (a known overwrite
  clash), and it enables cross-compilation.
- **Where it lands:** macOS `Contents/MacOS/reflect`; Windows `$INSTDIR\reflect.exe`;
  Linux `.deb` `/usr/bin/reflect` (**on PATH for free**); AppImage internal-only
  (documented limitation).
- **Signing is free on macOS:** Tauri signs sidecars inside-out with the hardened runtime,
  so notarization covers the CLI. Plan 15 note: universal builds need the sidecar
  `lipo`'d manually (Tauri only lipos the main binary).
- **No capability needed** for bundling (only if the app itself spawned the CLI).
- **PATH:** deb is automatic; macOS gets a VS-Code-style in-app "Install `reflect`
  command" (admin-prompted symlink to `/usr/local/bin`) and/or Homebrew, Windows an NSIS
  PATH hook, both Plan 15. Until then, `cargo install --path apps/cli`.

## Steps

1. **Workspace bootstrap** (root lockfile, `/target`, CI Rust job at the root).
2. **Extract `crates/index-schema`**; desktop re-exports; schema codegen re-pointed;
   desktop tests + codegen-drift check stay green.
3. **CLI scaffold:** commands, graph resolution, exit-code mapping, stdout/stderr
   contract.
4. **File layer** with **parity tests** sharing expected values with the TS tests
   (titles, keys, hashes), each pointing at its counterpart.
5. **Index layer:** read-only open, WAL fallback, schema guard, staleness.
6. **Commands** end-to-end: privacy gating, JSON, ranking.
7. **Sidecar bundling;** verify dev still works and the build bundles a runnable
   `reflect`.
8. **Docs:** [docs/cli.md](../cli.md) (commands, flags, exit codes, JSON, the agent
   discovery hook), Libraries, and the Architecture consequence.
9. **Tests:** `today` without an index; `search` ranking against a fixture index and
   private exclusion; `show`/`path` by date/title/alias/path with and without an index;
   stale warning still returns rows; JSON snapshots; private notes exit 3 even when the
   flag is newer than the index; parity tests.

## Key decisions / contracts

- **Read-only CLI**; no DB writes, no indexer runs; `search` warns on staleness rather
  than rebuilding.
- **Rust binary, not Node TS:** self-contained distribution + sidecar bundling outweigh
  TS-core reuse for a read-only surface. The duplicated contract is frozen, tiny, and
  parity-tested.
- **Graph = nearest `.reflect/`** (flag → env → cwd walk-up); **no desktop-config
  fallback**.
- **`private: true` notes are invisible to the CLI**, **no override**; the file's own
  frontmatter is checked, never just the index row.
- **stdout is data, stderr is diagnostics**; documented exit codes; stable,
  snapshot-locked JSON.
- **One workspace lockfile** pins the same SQLite for app and CLI.
- **Sidecar via `externalBin`** in desktop-only overlay configs, built by a
  before-command script with an explicit `--target`.

## Acceptance criteria

- One self-contained `reflect` binary whose commands work with no desktop app running.
- `today`/`show`/`path` work without the index; `search` exits 4 with a helpful message.
- An externally edited graph makes `search` warn stale while still returning rows.
- Private notes are never returned by any command, with no override.
- `--json` matches the documented schemas; parity tests pin the TS↔Rust contract.
- `pnpm tauri build` bundles a signed, runnable sidecar; dev and iOS builds are
  unaffected.

## Risks

- **TS↔Rust contract drift** (titles, fold keys, hash, FTS syntax) gives wrong answers
  that neither side's tests alone catch: parity tests with shared values, minimal
  cross-referenced surface. (JS `toLowerCase` vs Rust `to_lowercase` differ on a few
  Unicode cases: covered by a parity case, accepted.)
- **Concurrent access** with a running app: WAL + read-only + busy timeout means no lock
  contention; the WAL-recovery edge falls back to file-only.
- **Schema evolution:** a newer app may bump the schema ahead of an installed CLI; the
  guard + stable subset degrade gracefully (warn, not crash).
- **Mobile regressions from `externalBin`:** prevented by overlay configs, verified in
  step 7.
- **Workspace migration fallout** (CI caches, codegen path, tauri-cli target discovery):
  steps 1–2 land first and green on their own.
