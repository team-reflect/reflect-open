# Plan 12 — Backup & Sync (Git, GitHub-first)

**Goal:** Continuous, invisible backup and multi-device continuity over **Git**, with
**GitHub as the only remote in the product UX**. Edits are debounced into commits and
pushed; pulls merge on launch/focus; conflicts never wedge sync. No Git jargon in the UI.

**Depends on:** Plan 02 (graph, cloud-folder detection), Plan 04 (index + watcher
suppression), Plan 05 (external-change reconciliation for open notes, load-bearing for
conflicts), Plan 10 (keychain).
**Unlocks:** multi-device durability; AI-assisted conflict resolution (deferred).

**Architecture:** Git is a Rust primitive (`git2`); orchestration, cadence, GitHub
specifics, and conflict policy live in `@reflect/core` (`packages/core/src/sync/`). See
[Architecture & Conventions](architecture-conventions.md) and [Libraries](libraries.md).

## Discovery decisions (2026-06)

Re-derived with research; **supersedes the earlier backup-only scoping.**

1. **Engine: libgit2 via `git2`.** Rejected: **system git** (a fresh Mac has none and
   triggers the Xcode CLT prompt; impossible on iOS; leaks the user's gitconfig/hooks),
   **bundled git** (~50 MB of GPLv2 binaries to sign; no iOS), **gitoxide** (no push as of
   mid-2026), **isomorphic-git** (wrong layer; weak merge), **GitHub Git Data API with no
   local repo** (simplest, but GitHub lock-in and no local history, so no free checkpoint
   primitive). libgit2 is maintained; expect one breaking v2.0 bump, isolated in Rust.
2. **GitHub-only surface, generic core.** Rust speaks `remote URL + credential callback`.
   GitHub specifics (device flow, repo creation, error taxonomy) live in
   `packages/core/src/sync/github-*`. A custom-remote toggle is future UX, not engineering.
3. **Auth: GitHub App device flow.** Per-repo permission ("Reflect can touch one repo");
   8-hour tokens + 6-month refresh; **no client secret**, even for refresh, so no
   Reflect-hosted API. Fallback: a fine-grained PAT (also the GitHub Enterprise story).
   Tokens live in the keychain and go through the credential callback, **never in the
   remote URL**, so never on disk.
4. **Conflicts are committed, not blocking** (the Jujutsu model: conflicts are data). The
   original design wrote standard markers into notes, committed, and pushed, so the repo
   never wedged and both devices converged. **Spike verdict:** markers do **not** survive
   the editor round-trip (`=======` re-parses as a setext underline and content is lost),
   so the round-trip guard (Plan 05b) opened conflicted notes **protected** and
   resolution was a raw-text splice in the conflict notice (since removed).

   > **Current state:** a pull writes no markers. See
   > [git-backup-safety.md](../git-backup-safety.md) S7 and S9.
5. **Full loop in the first wave** (commit→push, pull/merge, restore in the graph
   chooser). Backup-only was rejected: a second device needs pull-before-push anyway.
6. **Disconnect is two verbs.** "Stop backing up" is per-graph (drops `origin`; history
   and credential stay). "Sign out of GitHub" is per-machine (clears the credential; every
   graph stops). Conflating them would let one graph's disconnect kill every backup.

## Product states

`Backed up` · `Backing up` · `Offline` (queued; retried on `online`, focus, next edit) ·
`Backup failed` (action needed). Git mechanics never surface.

## Sync loop

- **Commit cadence:** settled edits mark notes dirty → commit after ~30 s idle (cap 5 min
  of continuous editing) → push. Quit commits locally and never pushes, so a network
  stall cannot block exit; the next launch pushes. A pass with nothing to commit and
  nothing ahead **skips the network**, so a pull's own writes re-entering via the watcher
  do not each buy a push negotiation.
- **Pull cadence:** launch, window resume (focus, visible, online), Back up now, and a
  **non-fast-forward** rejection (fetch → merge → push, bounded retries). While visible, a
  desktop folder graph checks the remote tip every 90 s (ref advertisement only) and runs
  a full cycle only when it moved. iCloud graphs: [icloud-sync.md](../icloud-sync.md).
- **Hidden windows (iOS):** a started commit still pushes after hide; a pull does not
  start or continue. Auth, push-protection, and size failures surface at once; only
  divergence retries.
- **Merge, not rebase.** History is invisible to the product, and rewriting published
  history breaks multi-device.
- **Checkpoints = commits.** Plan 10's "checkpoint before AI patch" is "commit dirty files
  first": one recovery mechanism.
- **Mobile: foreground-only sync** in the first wave.

## Steps

1. **Rust git primitives** (`src-tauri/src/git/`), remote-agnostic. Health checks refuse
   foreign states (detached HEAD, in-progress rebase) with a typed error, never guess.
   `.reflect/` stays gitignored; the watcher tracks only `daily/` + `notes/`, so `.git/`
   is never watched.
2. **GitHub module** in core: device flow + silent refresh, repo create/metadata,
   `GET /user`, and an error taxonomy mapped to product states. **Repo-creation reality:**
   `POST /user/repos` works for classic PATs and OAuth tokens but **not fine-grained
   PATs**, which also cannot be scoped to a repo that does not exist. So the universal
   path is the prefilled `github.com/new` handoff, with API creation as a silent
   accelerator.
3. **Sync engine + backup controller.** The engine is abortable at every step boundary,
   single-flight with a strongest-mode follow-up, every failure mapped to a product state.
   The **backup controller** owns the per-graph lifecycle *outside React* with one
   teardown path; the provider is a `useSyncExternalStore` shim. (Every early review
   finding hit the React-effect/engine seam; this is the structural fix.)
4. **Conflict policy** (load-bearing):
   - **Content conflicts:** a `.md` note runs the conflict ladder and always resolves to
     text; other files keep both versions. No markers.
   - **Edit vs delete:** keep the edit (never silently delete).
   - **Binary/asset:** keep both (suffix the incoming copy); newest wins links.
   - Merges return their **changed files**; the controller reindexes them and fans them to
     open editors directly, so pull writes never depend on the watcher (the launch pull
     races watch start). Open notes use Plan 05 reconciliation (clean reloads; dirty
     prompts).
   - **Daily notes are the common collision.** A custom daily merge driver was planned;
     it shipped instead via [Plan 21](./21-icloud-drive-sync.md) as the ladder's
     append-union rung, on the iCloud path.
5. **Guardrails:**
   - Default to a **private repo**; a public repo needs explicit confirmation (`private:`
     blocks AI/cloud processing, **not** backup, so every note would be public).
   - Commit size pre-flight: warn ≥ 50 MB, exclude ≥ 95 MB. GitHub rejects > 100 MB and
     the **whole push** fails. Git LFS deferred.
   - Push protection rejecting a credential in a note → "a note contains something GitHub
     blocks", with the path when derivable.
   - Graph already a Git repo → offer to adopt it; never nest.
   - Onboarding says backup history is permanent; cloud-folder graphs still warn.
6. **Index coordination:** pulls register written paths for suppression; our commits must
   not re-dirty notes (no commit loops).
7. **Connect UX ordered around how GitHub tokens work:** **repository first** (the
   `github.com/new` handoff needs no credential), then the token (now scopable to that
   repo), then connect. Every sign-in ends in `GET /user`, so a bad token fails at entry
   and `owner/name` is never typed. A lapsed refresh token → `Backup failed — reconnect`.
8. **Restore / second device:** clone → open → full rebuild. Last-resort repair for a
   corrupt local repo: re-clone (the remote *is* the backup).
9. **Tests:** local bare-repo round-trip, two-clone divergence converges, non-fast-forward
   retry, edit/delete + binary policy, size guardrail, public confirmation, echo
   suppression, `.reflect/` excluded, token never in the remote URL or `.git/config`.

## Key decisions / contracts

- **Safety invariants** (2026-10): [docs/git-backup-safety.md](../git-backup-safety.md)
  lists rules S1 to S9 that every sync change must keep.
- **libgit2 is the engine**; GitHub specifics live only in `packages/core/src/sync/`.
- **GitHub is the only remote in the UX**; file-sync providers remain unsupported by
  design (no safe conflict semantics).
- **Device flow + keychain; PAT fallback; token never on disk.**
- **Conflicts never wedge sync.**
- **Disconnect is per-graph; sign-out is per-machine.**
- **Checkpoint = commit**; quit commits locally, never pushes.
- **Sync lifecycle lives outside React.**
- **Git mechanics never surface.**

## Acceptance criteria

- An edit goes `Backing up` → `Backed up` within the debounce window; the commit is on GitHub.
- Two devices editing the same note converge.
- A conflict never blocks other notes.
- Offline shows `Offline`; reconnecting pushes without user action.
- Restore reproduces the graph on a fresh machine; a non-empty destination is refused.
- Public repos need confirmation; an oversized file is excluded without failing the backup.

## Deferred

- meowdown conflict widget; AI-assisted resolution (`private: true` never goes to cloud AI).
- Git LFS / asset offload; background mobile sync; "purge history"; stale-`index.lock`
  recovery on startup.
- ~~Generic-remote UX toggle~~ → [Plan 16](16-generic-git-remotes.md): any host via a
  hand-wired `origin`, no UI.

## Risks

- ~~meowdown mangling markers~~ **Settled:** markers are lossy; a regression test pins the
  classification, and its failure would signal that an in-editor widget is possible.
- **Markers confuse non-developers.** Mitigated by never writing them.
- **libgit2 v2.0 bump**, absorbed in Rust.
- **Auth feels developer-oriented.** Device flow mitigates; PAT is the escape hatch.
- **History privacy** (deleted notes persist on GitHub): onboarding honesty now, purge later.
- **Watcher/sync write loops.** Suppression + no-re-dirty, both tested.
