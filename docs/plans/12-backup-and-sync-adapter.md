# Plan 12 — Backup & Sync (GitHub-only)

**Goal:** Free, understandable backup and light multi-device continuity over **GitHub
(Git)** — the single supported remote — in plain product language with no Git jargon.
File-sync providers (iCloud Drive, Dropbox, Google Drive) are **explicitly not** a Reflect
sync mechanism.

**Depends on:** Plan 02 (graph), Plan 04 (index + sync coordination), Plan 10 (keychain for
the GitHub token; AI only for the *deferred* conflict-resolution path).
**Unlocks:** multi-device durability via GitHub.

**Architecture:** Git (libgit2) + keychain are Rust primitives; sync orchestration, state,
and conflict policy live in `@reflect/core` (`actions/sync`). See
[Architecture & Conventions](architecture-conventions.md).

## Why GitHub-only (and why not iCloud / Dropbox / Drive)

File-sync providers move *bytes*, not *intent*, so they can't give Reflect safe sync
semantics:

- They replace files (including the SQLite index's `-wal`/`-shm`) underneath a running app
  → corruption (Plan 04).
- Their "conflict" handling is duplicate files (`note 2.md`) with **no base version**, so
  no reliable three-way merge is possible.
- No atomic multi-file commit, no merge base, no history Reflect controls.

Git gives a real **base/ours/theirs** merge model, atomic commits, controllable history,
and free hosting. So **GitHub is the only supported remote sync/backup.** Reflect keeps a
*thin internal seam* (for testability and to avoid painting into a corner) but ships and
supports exactly one implementation — this is **not** a multi-provider adapter framework.
Putting a graph *inside* a cloud-sync folder is unsupported and warned against (Plans 02 & 04).

## First-wave commitment (scope honesty)

First wave is **backup + manual conflict surfacing**, GitHub-only — not a full sync/merge
engine:

- GitHub **backup + restore** (push local → GitHub; restore on a new device);
- **manual conflict surfacing**: on the rare pull/restore conflict, show the readable
  base/local/remote diff and let the user choose a side or hand-merge — raw versions always
  recoverable.

**Deferred past first wave:** automatic bi-directional sync and **AI-assisted conflict
resolution** (kept specified below as the design target, not built now).

## Scope

**In:** GitHub/Git backup + restore (user-chosen repo), the product state vocabulary, the
Git-native base/local/remote conflict surface, local checkpoints, **manual** conflict
review UI, attachment/GitHub guardrails, `.reflect/` ignore, a thin internal Git seam.
**Out (unsupported by design):** any non-GitHub remote — **iCloud Drive, Dropbox, Google
Drive, local-folder, protocol sync**. **Out (deferred):** AI-assisted resolution, automatic
bi-directional sync, collaboration/multi-user.

## Steps

1. **Thin internal seam (not a framework).** One `GitRemote` interface so the UI + tests
   don't bind directly to libgit2. GitHub is the only implementation.

   ```ts
   export interface GitRemote {
     connect(repo: GitHubRepoRef): Promise<void>
     push(): Promise<void>
     pull(): Promise<SyncConflict[]>
     checkpoint(label: string): Promise<void> // recovery, not a user Git concept
     applyResolution(plan: ResolutionPlan): Promise<void> // deferred path
   }
   ```

2. **Git/GitHub backup (Rust, `git2`).** Map graph = repo, user-chosen GitHub repo =
   destination, commit = internal checkpoint, pull/fetch/merge = sync op, merge
   base/ours/theirs = base/local/remote, merge conflict = `SyncConflict`. Ignore `.reflect/`.
   **Hide Git entirely** behind product states: `Backed up`, `Syncing`, `Needs review`,
   `Resolved`, `Backup failed`. GitHub token in OS keychain (Plan 10) — never in
   markdown/Git/`.reflect/`.

3. **Conflict surface (Git-native).** A Git merge conflict becomes a
   `SyncConflict { notePath, kind, base?, local, remote }` — base/local/remote come straight
   from the merge, so there's nothing to "normalize across adapters." First wave: **manual
   review** (choose a side or hand-merge); raw versions stay recoverable.

   ```ts
   export interface SyncConflict {
     notePath: string
     kind: 'content' | 'rename' | 'delete-edit' | 'binary' | 'unknown'
     base?: NoteVersion   // merge base (Git provides it)
     local: NoteVersion
     remote: NoteVersion
   }
   ```

4. **Checkpoints (the recovery primitive).** Create checkpoints opportunistically after
   meaningful changes and **before any risky sync write or AI patch apply** (shared with
   Plan 10). Don't commit every keystroke (noisy history + churn). Raw conflicting versions
   always remain recoverable.

5. **Deferred — AI-assisted resolution (design target).** When built: parse base/local/
   remote → **if the note isn't `private: true`**, ask the copilot (Plan 10) to propose a
   merged note → reviewable patch → user accepts/edits/rejects → apply after checkpoint.
   Note-body conflicts always require review; private notes never go to cloud AI.

   ```ts
   export interface ResolutionPlan {
     mergedMarkdown: string
     summary: string
     confidence: 'high' | 'medium' | 'low'
     requiresReview: boolean
     warnings: string[]
   }
   ```

6. **Index coordination.** During pull/apply, signal the indexer (Plan 04) to suppress
   watcher storms, then reindex changed files after writes settle. Conflicts recorded in the
   `conflicts` table; sync state in `sync_state`.

7. **Attachments + GitHub guardrails.** Attachments stay normal files under `assets/` with
   relative links. **Warn** when binaries are likely to make GitHub backup slow/expensive/
   unreliable (size threshold). Git LFS / object storage deferred — not first wave.

8. **Tests.** Backup round-trips to a test repo; a hand-made merge conflict surfaces
   base/local/remote; manual resolution applies after a checkpoint and preserves raw
   versions; `.reflect/` excluded; large-binary warning fires; selecting a graph inside a
   cloud-sync folder triggers the unsupported-location warning (cross-check Plan 02).

## Key decisions / contracts

- **GitHub (Git) is the only supported remote sync/backup.** iCloud/Dropbox/Drive and
  local-folder sync are unsupported *by design* (no safe conflict semantics).
- **Thin internal seam, single implementation** — not an adapter framework.
- **Git mechanics never surface** — only plain Reflect states.
- **Git-native base/local/remote conflict; first-wave manual review;** AI resolution
  deferred.
- **Checkpoint before every risky write**; raw versions always recoverable.
- **GitHub token in OS keychain; no Reflect-hosted sync.**

## Acceptance criteria

- User connects a chosen GitHub repo; the graph backs up; UI shows `Backed up` / `Syncing`
  / `Backup failed` — never commits/branches/rebases.
- A conflict surfaces as `Needs review` with a readable base/local/remote diff; the user
  picks a side or hand-merges; raw versions stay recoverable.
- Selecting a graph **inside a cloud-sync folder** warns it's unsupported and recommends
  GitHub sync + a non-synced local path.
- `.reflect/` is excluded; large-binary backups warn.
- `pnpm typecheck` + tests pass.

## Risks

- **Users expecting iCloud/Dropbox to "just sync."** Set expectations explicitly in
  onboarding (Plan 15) and guide them to GitHub; warn on cloud-folder graph placement.
- **GitHub auth feeling developer-oriented.** Mitigate with a guided device-flow setup;
  token in keychain.
- **Hiding Git without trapping users** in broken states. Conservative auto-actions,
  always-recoverable raw versions, "needs review" over silent merges.
- **Watcher/sync write loops.** Suppression set + post-settle reindex (Plan 04).
