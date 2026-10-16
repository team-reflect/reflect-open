# Git backup safety invariants

The rules every change to the sync path must keep. "The sync path" is
`apps/desktop/src-tauri/src/git/`, `packages/core/src/sync/` (the sync
engine and the backup service), the backup flusher of
`packages/core/src/graph/persistence-flush-service.ts`, and the
note session's external-change handling in
`packages/core/src/documents/note-session-service.ts`.

Each rule names the test that enforces it. A rule whose test is still
`#[ignore]` / `test.fails` is a known gap: the test is red on purpose and
the fix that turns it green is named in its ignore reason.

## S1. A pull never overwrites uncommitted local changes

A note saved after the cycle's commit (during the fetch, for example) is
not clobbered by the checkout that applies the pull. The pull defers that
file and the app merges it afterwards.

- Test: pending (`merge.rs` safe checkout).

Status (2026-10-16): implemented in phase 4 of the sync rework.

## S2. The branch ref moves only after the working tree matches it

On a fast-forward, files are written first and the branch pointer moves
last. A failure in between leaves the ref where it was, so the next cycle
retries the pull instead of committing the stale tree. A merge follows the
same order: the merge commit is written, then its tree is checked out, and
the ref moves last.

- Test: `git::tests::fast_forward_checkout_failure_never_reverts_pulled_notes`,
  `git::tests::stale_head_lock_fast_forward_never_reverts_pulled_notes`,
  `git::tests::fast_forward_with_a_stale_head_lock_succeeds`,
  `git::tests::merge_crash_before_checkout_converges_next_cycle`,
  `git::tests::merge_crash_after_checkout_before_ref_move_converges_next_cycle`.

Status (2026-10-16): fast-forward implemented (#1468); merge implemented in
phase 1 of the sync rework.

## S3. After any failed git command, the next cycle loses nothing

Whatever step fails (lock file, disk, network, crash), running the normal
cycle again (commit, fetch, merge, push) converges on a tree that contains
every local and every remote change. In particular it never pushes a commit
that reverts a pull.

- Test: `git::tests::fast_forward_failure_before_the_ref_moves_converges_next_cycle`
  (green), plus every S2 and S5 test.

Status (2026-10-16): already implemented.

## S4. One git command at a time per graph

Git commands, note writes, and iCloud sweep writes on the same graph are
serialized. The quit-time and background flush go through the sync engine's
queue, never straight to `git_commit_all`.

- Test: `git::tests::commit_during_fast_forward_never_reverts_pulled_notes`,
  `backup-service.test.ts` "quit flush waits for an
  in-flight pull before committing", `engine.test.ts` "commitNow joins the
  single-flight queue and never touches the network".

Status (2026-10-16): implemented in phase 1 of the sync rework.

## S5. The repository is never left in app-made merge state

A pull computes the merge in memory and never calls `repo.merge()`, so no
stop can leave `MERGE_HEAD` behind. Until the branch ref moves, the merge
commit is recorded in `refs/reflect/merge`, and the next commit or pull
checks it out and moves the ref to it instead of merging again. Foreign state (a merge or rebase the user
started with the git CLI) is still refused.

- Test: `git::tests::merge_interrupted_before_commit_converges_next_cycle`,
  `git::tests::merge_never_leaves_merge_head`,
  `git::tests::edits_after_a_merge_crash_survive_the_next_cycle`,
  `git::tests::edits_after_a_crash_before_checkout_keep_the_merged_changes`,
  `git::tests::a_recorded_merge_from_a_foreign_head_is_dropped`.

Status (2026-10-16): implemented in phase 1 of the sync rework.

## S6. `.reflect/` never enters a commit

The runtime directory is excluded by `.gitignore`, by an in-memory ignore
rule, and by removing entries an older repository already
tracked.

- Test: `git::tests::commit_excludes_reflect_and_skips_when_clean` (untracked
  files), `git::tests::tracked_reflect_entries_are_dropped_from_the_next_commit`
  (entries an adopted repository already tracked).

Status (2026-10-16): already implemented.

## S7. Conflicts are committed and pushed, never left pending

A merge with conflicts writes labeled markers into the note, commits with
both parents, and pushes. Other notes keep syncing; both devices converge on
the same marked-up file.

- Test: `git::tests::conflicting_edits_are_committed_with_labeled_markers`,
  `git::tests::edit_vs_delete_keeps_the_edit`,
  `git::tests::binary_conflict_keeps_both_copies`.

Status (2026-10-16): implemented in phase 3 of the sync rework.

## S8. Edits in an open note are never silently discarded

When external content arrives while the buffer has unsaved edits, the
session merges, or parks the conflict and keeps both sides. Leaving the note
with a parked conflict archives the buffer instead of dropping it.

- Test: `note-session.test.ts` "keepMine rewrites the file even when the
  conflict content equals the buffer"; archive-on-dispose pending.

Status (2026-10-16): implemented in phase 4 of the sync rework.
