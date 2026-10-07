# Git backup safety invariants

The rules every change to the sync path must keep. "The sync path" is
`apps/desktop/src-tauri/src/git/`, `packages/core/src/sync/`,
`apps/desktop/src/lib/backup-controller.ts`, `backup-flush.ts`, and the
note session's external-change handling in
`apps/desktop/src/editor/note-session-state.ts`.

Each rule names the test that enforces it. A rule whose test is still
`#[ignore]` / `test.fails` is a known gap: the test is red on purpose and
the fix that turns it green is named in its ignore reason.

## S1. A pull never overwrites uncommitted local changes

A note saved after the cycle's commit (during the fetch, for example) is
not clobbered by the checkout that applies the pull. The pull defers that
file and the app merges it afterwards.

- Test: pending (`merge.rs` safe checkout).

## S2. The branch ref moves only after the working tree matches it

On a fast-forward, files are written first and the branch pointer moves
last. A failure in between leaves the ref where it was, so the next cycle
retries the pull instead of committing the stale tree.

- Test: `git::tests::fast_forward_checkout_failure_never_reverts_pulled_notes`,
  `git::tests::stale_head_lock_fast_forward_never_reverts_pulled_notes`
  (both `#[ignore]` until the fast-forward reorder lands).

## S3. After any failed git command, the next cycle loses nothing

Whatever step fails (lock file, disk, network, crash), running the normal
cycle again (commit, fetch, merge, push) converges on a tree that contains
every local and every remote change. In particular it never pushes a commit
that reverts a pull.

- Test: `git::tests::fast_forward_failure_before_the_ref_moves_converges_next_cycle`
  (green), plus every S2 and S5 test.

## S4. One git command at a time per graph

Git commands, note writes, and iCloud sweep writes on the same graph are
serialized. The quit-time and background flush go through the sync engine's
queue, never straight to `git_commit_all`.

- Test: `git::tests::commit_during_fast_forward_never_reverts_pulled_notes`
  (`#[ignore]`), `backup-controller.test.tsx` "quit flush waits for an
  in-flight pull before committing" (`test.fails`).

## S5. The repository is never left in app-made merge state

A pull that dies between `repo.merge()` and the merge commit must not leave
`MERGE_HEAD` behind, because every later cycle refuses to run on a
repository mid-merge. Foreign state (a rebase the user started with the
git CLI) is still refused.

- Test: `git::tests::merge_interrupted_before_commit_converges_next_cycle`
  (`#[ignore]`).

## S6. `.reflect/` never enters a commit

The runtime directory is excluded by `.gitignore`, by an in-memory ignore
rule, and (pending) by removing entries an older repository already
tracked.

- Test: `git::tests::commit_excludes_reflect_and_skips_when_clean` (untracked
  `.reflect/` files only). Known gap: tracked-entry cleanup is pending its own
  regression (`commit_removes_previously_tracked_reflect_files`).

## S7. Conflicts are committed and pushed, never left pending

A merge with conflicts writes labeled markers into the note, commits with
both parents, and pushes. Other notes keep syncing; both devices converge on
the same marked-up file.

- Test: `git::tests::conflicting_edits_are_committed_with_labeled_markers`,
  `git::tests::edit_vs_delete_keeps_the_edit`,
  `git::tests::binary_conflict_keeps_both_copies`.

## S8. Edits in an open note are never silently discarded

When external content arrives while the buffer has unsaved edits, the
session merges three-way. Disjoint edits apply and keep saving; overlapping
edits are written into the file as labeled markers (the note opens
protected, like a conflicted pull); edits that cannot be merged are kept as
`<note> (conflict).md` beside the note. The buffer is never left in a state
it cannot save from, so no exit path has to rescue it.

- Test: `note-session.test.ts` "a clean three-way merge applies silently and
  keeps saving", "overlapping edits are written into the file as markers and
  open protected", "edits that cannot be merged are kept beside the note".
