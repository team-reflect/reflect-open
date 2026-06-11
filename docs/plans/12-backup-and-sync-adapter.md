# Plan 12 — Backup & Sync (Git, GitHub-first)

**Goal:** Continuous, invisible backup and multi-device continuity over **Git**, with
**GitHub as the only remote in the product UX**. Edits are debounced into commits and
pushed; pulls merge on launch/focus; merge conflicts are **committed into the note as
standard Git conflict markers** so sync never wedges. Plain product language — no Git
jargon in the UI.

**Depends on:** Plan 02 (graph, cloud-folder detection), Plan 04 (index + watcher
suppression; adds `sync_state`/`conflicts` tables), Plan 05 (external-change
reconciliation for open notes — load-bearing for conflicts), Plan 10 (keychain).
**Unlocks:** multi-device durability; AI-assisted conflict resolution (deferred).

**Architecture:** Git is a Rust primitive (`git2`/libgit2); sync orchestration, cadence,
GitHub specifics, and conflict policy live in `@reflect/core` (`actions/sync`). See
[Architecture & Conventions](architecture-conventions.md).

**Libraries:** `git2` (libgit2), `keyring` — Rust. (`diff`/jsdiff returns for the
deferred conflict-widget/AI path.) See [Libraries](libraries.md).

## Discovery decisions (2026-06)

Re-derived with research; **supersedes this plan's earlier backup-only scoping.**

1. **Engine: libgit2 via `git2`.** Rejected: **system git** (a fresh Mac has none —
   invoking it triggers the Xcode CLT install prompt; impossible on iOS; leaks the user's
   gitconfig/hooks into our sync), **bundled git** (~50 MB of GPLv2 binaries to
   sign/notarize; no iOS), **gitoxide** (no push support as of mid-2026),
   **isomorphic-git** (wrong layer per conventions; weak merge), and **GitHub's Git Data
   API with no local repo** (operationally simplest, but structural GitHub lock-in and no
   local history — losing the free checkpoint primitive). libgit2 is maintained (1.9.x;
   v2.0/SHA-256 upcoming — expect one breaking bump, isolated behind the Rust module).
2. **GitHub-only surface, generic core.** The Rust layer speaks `remote URL + credential
   callback` — nothing GitHub-specific. GitHub specifics (device flow, repo creation,
   error taxonomy) are isolated in `actions/sync/github.ts`. "Custom Git remote
   (advanced)" stays a future UX toggle, not an engineering project.
3. **Auth: GitHub App device flow.** Fine-grained, per-repo permission ("Reflect can
   touch one repo, nothing else"); 8-hour user tokens + 6-month refresh tokens; device
   flow needs **no client secret**, even for refresh — consistent with no Reflect-hosted
   APIs. Fallback: a manually created fine-grained PAT (also the GitHub Enterprise
   story). Tokens live in the OS keychain (Plan 10), supplied via libgit2's credential
   callback — **never embedded in the remote URL**, so never on disk.
4. **Conflicts are committed, not blocking** (the Jujutsu model: conflicts are data). A
   conflicted merge writes standard `<<<<<<<`/`=======`/`>>>>>>>` markers into the
   affected notes, then **commits the merge and pushes** — the repo is never wedged,
   other notes keep syncing, both devices converge on the same marked-up note. The user
   resolves by editing the note, whenever, on either device. Future: a meowdown widget
   renders marker blocks with keep-mine/keep-theirs buttons.
5. **Full loop in the first wave** — debounced commit→push *and* pull/merge. Backup-only
   was rejected: a second device needs pull-before-push anyway, so deferral bought little.

## Product states

`Backed up` · `Backing up` · `Pending` (offline; commits accumulate) · `Needs review`
(conflict markers present) · `Backup failed` (action needed). Git mechanics never surface.

## Sync loop

- **Commit cadence:** a watcher-settled edit marks the note dirty → commit all dirty
  files after ~30 s idle (cap: 5 min of continuous editing) → push. One commit per
  batch, auto-generated message ("Update 3 notes"). Commit on quit.
- **Pull cadence:** on launch, on window focus, on a periodic timer, and on a
  **non-fast-forward** push rejection: fetch → merge → push again (bounded retries).
  Auth, push-protection, and size failures surface immediately — only divergence retries.
- **Merge, not rebase.** Single branch; merge commits are fine — history is invisible
  product-wise, and rewriting published history breaks multi-device.
- **Checkpoints = commits.** Plan 10's "checkpoint before AI patch apply" becomes
  "commit dirty files first" — one recovery mechanism; any version recoverable from
  local or remote history.
- **Mobile (iOS target): foreground-only sync** first wave.

## Steps

1. **Rust git primitives** (`src-tauri/src/git/`): `git_status`, `git_setup` (init or
   adopt-existing + `origin` + align the local branch with the remote's default),
   `git_commit_all(message)` (stage everything, no-op when clean, large-file
   guardrail), `git_fetch`, `git_merge_remote` (fast-forward or merge; writes marker
   files with labeled sides, commits conflicts, reports changed files for reindexing),
   `git_push` (rejections returned as data). Health checks: refuse foreign states —
   detached HEAD, in-progress rebase — with a typed error, never guess. Remote-agnostic;
   credentials via callback from the keychain. `.reflect/` stays gitignored (Plan 02);
   the watcher only tracks `daily/` + `notes/`, so `.git/` is never watched.

2. **GitHub module** (`sync/github.ts` in core): device flow + silent token refresh,
   guided private-repo creation, repo metadata (visibility, default branch), and an
   error taxonomy (auth, network, secret-scanning push protection, size) mapped to
   product states. zod at the boundary.

3. **Sync engine** (`actions/sync/`): the state machine + debounce scheduler; consumes
   watcher events for dirty tracking; orchestrates the Rust primitives; persists
   `sync_state`; records conflicted notes in `conflicts`; maps **every** failure to a
   product state (fail loud, never silent).

4. **Conflict policy** (the load-bearing step):
   - **Content conflicts** → marker blocks with readable labels (`<<<<<<< this device` /
     `>>>>>>> other device`); merge committed + pushed; note flagged `Needs review`;
     resolution detected when markers disappear on a later save/reindex.
   - **Edit vs delete** → keep the edited version (never silently delete); record it.
   - **Binary/asset conflicts** → keep both (suffix the incoming copy); newest wins links.
   - **Known wrinkle:** raw markers parse oddly as markdown (`=======` after a text line
     reads as a setext heading) and meowdown may escape `<` on round-trip. First wave
     accepts the display oddity; **spike early** that editing elsewhere in a conflicted
     note doesn't mangle the markers. The future meowdown conflict node fixes presentation.
   - A pull can rewrite an **open** note — goes through Plan 05's external-change
     reconciliation (clean buffer reloads; dirty buffer prompts).
   - **Daily notes are the common collision** (two devices, same day). Markers are
     acceptable first wave; future: a custom merge driver (libgit2 registers them in
     code) for append-friendly merging of `daily/*.md`.

5. **Guardrails:**
   - Default to **creating a private repo**; choosing a public repo blocks on an explicit
     confirmation (all notes — including `private: true` ones — would be public;
     `private:` blocks AI/cloud-processing, **not** backup).
   - Pre-flight file sizes at commit: warn ≥ 50 MB, exclude ≥ 95 MB with a warning —
     GitHub rejects files > 100 MB and the **whole push** fails. Git LFS deferred.
   - GitHub push protection can reject a push because a note contains a credential —
     surface as "a note contains something GitHub blocks", with the path when derivable.
   - Graph is already a Git repo → offer to adopt it (and its remote); never nest.
   - Onboarding states plainly: backup history is permanent (deleted notes remain in
     history); cloud-sync-folder graphs still warn (Plan 02).

6. **Index coordination** (Plan 04): merges/pulls register written paths in the
   suppression set and reindex after writes settle; our own commits must not re-mark
   notes dirty (no commit loops).

7. **Auth UX:** guided device flow ("enter this code on github.com"), app install scoped
   to the backup repo; silent 8-hour refresh; a lapsed refresh token → `Backup failed —
   reconnect` with a one-click re-run. Advanced path: paste a fine-grained PAT.

8. **Restore / second device:** "Connect existing backup" = clone → open as graph →
   full index rebuild (Plan 04). Repair of last resort for a corrupt local repo:
   re-clone from the remote (the remote *is* the backup).

9. **Tests:** round-trip backup to a local bare repo; two-clone divergence produces a
   committed marker merge both sides converge on; non-fast-forward push retries;
   edit/delete + binary policies; marker removal clears `Needs review`; size guardrail;
   public-repo confirmation; echo suppression (a pull doesn't storm the indexer; commits
   don't re-dirty); `.reflect/` excluded; token never appears in the remote URL or
   `.git/config` (asserted). (Stale-`index.lock` recovery is deferred, below.)

## Key decisions / contracts

- **libgit2 (`git2`) is the engine**; the Rust surface is remote-agnostic, GitHub
  specifics live only in `actions/sync/github.ts`.
- **GitHub is the only supported remote in the UX**; file-sync providers (iCloud/
  Dropbox/Drive) remain unsupported by design (no safe conflict semantics).
- **GitHub App device flow + keychain; PAT fallback; token never on disk.**
- **Conflicts are committed as raw Git markers and sync continues** — no wedged states,
  no modal resolution flow; resolution = editing the note.
- **Checkpoint = commit** (shared recovery primitive with Plan 10).
- **Git mechanics never surface** — only the five product states.

## Acceptance criteria

- Editing a note passes through `Backing up` → `Backed up` within the debounce window;
  the commit is visible on GitHub.
- Two devices editing the same note converge on one note containing labeled conflict
  markers; both show `Needs review`; resolving on either device clears it everywhere.
- A conflict never blocks other notes from backing up.
- Going offline shows `Pending`; reconnecting pushes without user action.
- "Connect existing backup" on a fresh machine reproduces the graph; the index rebuilds.
- Public-repo selection requires explicit confirmation; an oversized file warns/excludes
  without failing the rest of the backup.
- `pnpm typecheck` + targeted tests pass.

## Deferred

- meowdown conflict widget (parse marker blocks → keep-mine/keep-theirs UI).
- AI-assisted resolution via the Plan 10 copilot (markers parse to base/ours/theirs;
  `private: true` notes never go to cloud AI).
- Custom merge driver for daily notes; Git LFS / asset offload; generic-remote UX
  toggle; background sync on mobile; "purge history" escape hatch; stale-`index.lock`
  recovery on startup.

## Risks

- **meowdown mangling markers** (escaping on round-trip) — spike first; if escaping
  breaks markers, render the same merge output as an escaping-safe Reflect block instead.
- **Markers confuse non-developers.** Mitigate with the `Needs review` state, labeled
  sides, and the future editor widget.
- **libgit2 v2.0 breaking bump** — absorbed behind the Rust module.
- **Auth feeling developer-oriented.** Device flow mitigates; PAT is the escape hatch.
- **History privacy** (deleted notes persist on GitHub) — onboarding honesty now;
  "purge history" later.
- **Watcher/sync write loops.** Suppression set + the no-re-dirty contract, both tested.
