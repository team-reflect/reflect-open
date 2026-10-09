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
  `git::tests::stale_head_lock_fast_forward_never_reverts_pulled_notes`,
  `git::tests::fast_forward_with_a_stale_head_lock_succeeds`.

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
  in-flight pull before committing", `engine.test.ts` "commitNow joins the
  single-flight queue and never touches the network".

## S5. The repository is never left in app-made merge state

A pull that dies between `repo.merge()` and the merge commit leaves
`MERGE_HEAD`, a merged index, and the merge's checkout behind. The next
command finishes that merge (both parents, conflicts handled as the pull
would have, a conflicted note staged as it is on disk now) and carries on,
so a crash never wedges the backup and never records the merge's output as a
local edit. Only a merge of the branch's own remote is finished this way;
any other in-progress state (a rebase or a merge the user started with the
git CLI) is still refused.

- Test: `git::tests::merge_interrupted_before_commit_converges_next_cycle`,
  `git::tests::merge_interrupted_on_a_text_conflict_is_finished_not_recommitted`,
  `git::tests::an_edit_made_after_the_crash_survives_the_finished_merge`,
  `git::tests::a_crash_after_the_merge_commit_only_clears_the_state`,
  `git::tests::a_merge_the_user_started_is_still_refused`,
  `git::tests::a_foreign_rebase_is_still_refused`.

## S6. `.reflect/` never enters a commit

The runtime directory is excluded by `.gitignore`, by an in-memory ignore
rule, and (pending) by removing entries an older repository already
tracked.

- Test: `git::tests::commit_excludes_reflect_and_skips_when_clean` (untracked
  files), `git::tests::tracked_reflect_entries_are_dropped_from_the_next_commit`
  (entries an adopted repository already tracked).

## S7. Conflicts are committed and pushed, never left pending

A merge with conflicts writes labeled markers into the note, commits with
both parents, and pushes. Other notes keep syncing; both devices converge on
the same marked-up file.

- Test: `git::tests::conflicting_edits_are_committed_with_labeled_markers`,
  `git::tests::edit_vs_delete_keeps_the_edit`,
  `git::tests::binary_conflict_keeps_both_copies`.

## S8. Edits in an open note are never silently discarded

When external content arrives while the buffer has unsaved edits, the
session merges, or parks the conflict and keeps both sides. Leaving the note
with a parked conflict archives the buffer instead of dropping it.

- Test: `note-session.test.ts` "keepMine rewrites the file even when the
  conflict content equals the buffer"; archive-on-dispose pending.
