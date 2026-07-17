# Plan 02 — Graph & File Storage

**Goal:** Define the on-disk graph and the Rust file-IO layer that makes markdown files
the durable source of truth. Everything else reads and writes through this contract.

**Depends on:** Plan 01 (IPC bridge, app shell).
**Unlocks:** Plan 03 (parsing), 04 (indexing), 06 (daily notes), 11 (capture writes),
12 (sync wraps the graph), 13 (import/export), 14 (CLI).

**Architecture:** atomic file IO, OS-trash delete, and the path-traversal guard are Rust
primitives; the `notes`/`graph` **setters** that orchestrate writes + reindex live in
`@reflect/core`. See [Architecture & Conventions](architecture-conventions.md).

**Libraries:** `tempfile` (atomic write), `trash` (delete-to-OS-trash), `dirs`
(OS app-config) — Rust; `ulid` (Rust) / `ulidx` (TS) for note IDs. See
[Libraries](libraries.md).

## Scope

**In:** graph directory contract, graph open/create/recent, atomic file read/write/
move/delete in Rust, note identity + minimal frontmatter, path conventions, `.reflect/`
graph dir, ignore defaults.
**Out:** parsing markdown content (Plan 03), indexing (Plan 04). This layer moves bytes
and paths, not meaning.

## The graph contract

A **graph** is a user-chosen folder — Reflect's name for the note workspace. Default
layout:

```text
<graph>/
├── journal/YYYY-MM-DD.md      # daily notes; date derivable from path
├── notes/<slug>.md          # regular notes; readable filenames
├── assets/                  # attachments; referenced via relative md links
├── audio-memos/             # raw memo recordings (created on demand, not
│                            #   bootstrapped); each pairs with a same-named
│                            #   transcription note under notes/
└── .reflect/                # ignored: SQLite index, caches, local app state
    ├── index.sqlite
    └── ...
```

Rules (from the product vision storage model):

- One note per markdown file.
- Daily-note date comes from the path; no `title` frontmatter required for dailies.
- Filenames are stable and human-readable; renames are handled in Plan 07.
- `.reflect/` holds only rebuildable indexes + non-content local state, and is added to
  `.gitignore` inside the graph.
- Large binaries get backup guardrails later (Plan 12); this layer just stores files.

### Note identity & frontmatter (minimal)

Frontmatter stays minimal — identity, aliases, and `private` only when needed.

```yaml
---
id: 01J9Z8...      # stable note ID (ULID), survives rename
aliases: [Mum]     # optional; preserves links across renames
private: true      # optional; hard-blocks cloud AI/capture for this note
---
```

- **ID scheme:** ULID (sortable, URL-safe, no central authority). Generated on first
  write of a regular note. Daily notes can omit `id` (path is identity) but may carry one.
- The parser (Plan 03) tolerates missing/unknown frontmatter; identity falls back to path.
- Decision recorded as an open question in the docs: whether every note must carry `id`.
  First wave: regular notes get an `id`; daily notes are path-identified.

## Steps

1. **Rust file-IO module** (`src-tauri/src/fs/`): commands for
   `graph_open(path)`, `graph_create(path)`, `note_read(path)`,
   `note_write(path, contents)`, `note_move(from, to)`, `note_delete(path)` (to OS
   trash, not hard delete), `list_files(globs)`, `ensure_dirs()`. All paths are
   graph-relative; the graph root is held in Rust app state and never trusted
   from the frontend as an absolute escape (path-traversal guard).

2. **Atomic writes.** Write to a temp file in the same dir + `fsync` + rename, so an
   interrupted save never corrupts a note. Preserve trailing-newline / line-ending style
   on rewrite where practical (reduces sync churn in Plan 12).

3. **Graph selection UX.** First-run picker (Tauri dialog) to choose/create a graph;
   persist recent graphs in local app state (not in `.reflect/` of any one graph — use
   the OS app-config dir). A `GraphProvider` + `useGraph` hook exposes the
   active graph root and ready-state to the UI.

4. **`.reflect/` bootstrap.** On open, ensure `journal/`, `notes/`, `assets/`,
   `.reflect/` exist; write a graph `.gitignore` (ignoring `.reflect/`) and a tiny
   `.reflect/meta.json` (schema version) so upgrades can detect format changes.

5. **Capability grants.** Tauri 2 requires explicit FS/dialog permissions in
   `src-tauri/capabilities/`. Grant scoped FS access to the chosen graph dir and the
   dialog plugin. Keep grants as narrow as the product allows.

6. **macOS file-access reality (load-bearing — the in-graph index decision depends on
   it).** The native process must hold *durable* read/write access to an arbitrary
   user-chosen folder:
   - **Notarized, non-sandboxed (Plan 15's default):** macOS **TCC** still gates
     `~/Documents`, `~/Desktop`, `~/Downloads`, and iCloud — the OS shows a consent prompt
     on first access. Onboarding (Plan 15) must expect/explain this, and a graph in a
     non-protected location avoids it. Tauri's `persisted-scope` re-grants the app's own
     path scope across launches.
   - **If ever App-Store-sandboxed:** durable access to a user folder requires
     **security-scoped bookmarks** (create on pick, resolve + `startAccessing…` on launch)
     — an Apple API **Tauri does not wrap**, so it needs custom Rust (objc2/core-foundation).
     Treat sandboxing as a later decision; first release is notarized non-sandboxed.
   - **Keep `.reflect/` local-only where providers support it.** Remote sync is
     GitHub-only (Plan 12), so the in-graph `.reflect/` bootstrap marks its rebuildable
     state as local-only instead of exposing graph-level cloud-provider metadata.

7. **Path helpers (TS).** `packages/core` `graph/paths.ts`: `dailyPath(date)`,
   `notePath(slug)`, `assetPath(name)`, `isDaily(path)`, `dateFromDailyPath(path)`.
   Pure, unit-tested, shared by every later phase.

8. **Zod boundary schemas.** Validate every Rust response (`FileMeta`, `GraphInfo`)
   with zod, normalized to camelCase per Plan 01.

## Key decisions / contracts

- **Graph root lives in Rust state.** The frontend addresses files by relative path
  only; Rust resolves + guards against traversal. This is the security boundary.
- **Delete = OS trash.** Honors the V1 "restore" trust value without building history yet.
- **Recents live in OS app-config**, graph-scoped state lives in that graph's `.reflect/`.

## Acceptance criteria

- User picks a folder; app scaffolds `journal/ notes/ assets/ .reflect/` + `.gitignore`.
- A note can be written and read back byte-identical through the IPC layer.
- Deleting a note moves it to OS trash; reopening the graph still works.
- Path helpers have unit tests covering journal/regular/asset and traversal rejection.
- `pnpm typecheck` + targeted tests pass.

## Risks

- **Path traversal / sandbox escapes.** Mitigate with the Rust-side root + canonicalize
  + prefix check on every path.
- **iCloud/Dropbox placeholder files** (not-yet-downloaded). Note the case now; handle
  materialization in Plan 04 file-watching and Plan 12 sync.
- **Case-insensitive vs case-sensitive filesystems** (APFS default vs Linux). Normalize
  slug casing decisions now to avoid collisions later (Plan 07 leans on this).
