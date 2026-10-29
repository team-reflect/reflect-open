# Plan 02 — Graph & File Storage

**Goal:** Define the on-disk graph and the Rust file-IO layer that makes Markdown files
the durable source of truth. Everything else reads and writes through this contract.

**Depends on:** Plan 01 (IPC bridge, app shell).
**Unlocks:** Plan 03 (parsing), 04 (indexing), 06 (daily notes), 11 (capture writes),
12 (sync), 13 (import/export), 14 (CLI).

**Architecture:** atomic file IO, OS-trash delete, and the path-traversal guard are Rust
primitives; the `notes`/`graph` **setters** that orchestrate writes + reindex live in
`@reflect/core`. See [Architecture & Conventions](architecture-conventions.md).

**Libraries:** `tempfile` (atomic write), `trash` (OS trash), `dirs` (OS app-config),
`ulid` (Rust and TS) for note IDs. See [Libraries](libraries.md).

## Scope

**In:** graph directory contract, graph open/create/recent, atomic read/write/move/delete
in Rust, note identity + minimal frontmatter, path conventions, `.reflect/`, ignore
defaults.
**Out:** parsing (Plan 03), indexing (Plan 04). This layer moves bytes and paths, not
meaning.

## The graph contract

A **graph** is a user-chosen folder. Default layout:

```text
<graph>/
├── daily/YYYY-MM-DD.md      # daily notes; date derivable from path
├── notes/<slug>.md          # regular notes; readable filenames
├── assets/                  # attachments; referenced via relative md links
├── audio-memos/             # memo recordings (created on demand); each pairs
│                            #   with a same-named transcription note in notes/
└── .reflect/                # ignored: SQLite index, caches, local app state
```

Rules:

- One note per Markdown file.
- Daily date comes from the path; dailies need no `title` frontmatter.
- Filenames are stable and human-readable; renames are Plan 07.
- `.reflect/` holds only rebuildable indexes + non-content local state, and is
  gitignored inside the graph.
- Large-binary backup guardrails come later (Plan 12).

### Note identity & frontmatter (minimal)

```yaml
---
id: 01J9Z8...      # stable note ID (ULID), survives rename
aliases: [Mum]     # optional; preserves links across renames
private: true      # optional; hard-blocks cloud AI/capture for this note
---
```

- **ID scheme:** ULID (sortable, URL-safe, no central authority), generated on first
  write of a regular note. Dailies may omit `id` (path is identity).
- The parser tolerates missing/unknown frontmatter; identity falls back to path.
- Open question: whether every note must carry `id`. First wave: regular notes do,
  dailies are path-identified.

## Steps

1. **Rust file-IO commands** for graph open/create, note read/write/move/delete (delete
   to OS trash), file listing, and dir bootstrap. All paths are graph-relative; the
   root is held in Rust state and never trusted from the frontend (traversal guard).
2. **Atomic writes:** temp file in the same dir + `fsync` + rename, so an interrupted
   save never corrupts a note. Use `\n` line endings and preserve trailing-newline
   style where practical (less sync churn).
3. **Graph selection UX:** first-run picker to choose/create a graph. Recent graphs
   live in the OS app-config dir, not in any graph's `.reflect/`.
4. **Bootstrap on open:** ensure `daily/`, `notes/`, `assets/`, `.reflect/`; write a
   graph `.gitignore` (ignoring `.reflect/`) and `.reflect/meta.json` (schema version)
   so upgrades can detect format changes.
5. **Capability grants:** Tauri 2 needs explicit FS/dialog permissions; keep them as
   narrow as the product allows.
6. **macOS file access (the in-graph index decision depends on it).** The app must hold
   durable read/write access to an arbitrary user folder:
   - **Notarized, non-sandboxed (Plan 15's default):** TCC still gates `~/Documents`,
     `~/Desktop`, `~/Downloads`, and iCloud with a first-access prompt. Onboarding must
     explain it; a non-protected location avoids it. `persisted-scope` re-grants the
     app's path scope across launches.
   - **If ever App-Store-sandboxed:** durable access needs security-scoped bookmarks,
     an Apple API Tauri does not wrap (custom Rust). Sandboxing is a later decision.
   - **Keep `.reflect/` local-only.** Remote sync is GitHub-only (Plan 12), so the
     bootstrap marks rebuildable state local-only instead of exposing cloud-provider
     metadata.
7. **Path helpers (TS)** in `packages/core`: pure, unit-tested, shared by later phases.
8. **Zod boundary schemas** validate every Rust response, normalized to camelCase.

## Key decisions / contracts

- **Graph root lives in Rust state.** The frontend addresses files by relative path
  only; Rust resolves and guards against traversal. This is the security boundary.
- **Delete = OS trash.** Honors V1's "restore" trust value without building history.
- **Recents live in OS app-config**; graph-scoped state lives in that graph's `.reflect/`.

## Acceptance criteria

- Picking a folder scaffolds `daily/ notes/ assets/ .reflect/` + `.gitignore`.
- A note round-trips byte-identical through IPC.
- Delete moves to OS trash; reopening the graph still works.
- Path helpers are unit-tested for daily/regular/asset and traversal rejection.

## Risks

- **Path traversal:** Rust-side root + canonicalize + prefix check on every path.
- **iCloud/Dropbox placeholder files:** handle materialization in Plan 04 watching and
  Plan 12 sync.
- **Case-insensitive vs case-sensitive filesystems:** normalize slug casing now to
  avoid collisions later (Plan 07 relies on this).
