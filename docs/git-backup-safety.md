# Git backup safety invariants

The rules every change to the sync path must keep. "The sync path" is
`apps/desktop/src-tauri/src/git/`, `packages/core/src/sync/` (the sync
engine and the backup service), the backup flusher of
`packages/core/src/graph/persistence-flush-service.ts`, and the
note session's external-change handling in
`packages/core/src/documents/note-session-service.ts`.

Each rule names the tests that enforce it. Every rule below is
implemented.

## S1. A pull never overwrites uncommitted local changes

A note saved after the cycle's commit (during the fetch, for example) is
not clobbered by the checkout that applies the pull. The checked write
merges inside the graph lock, and the pull's checkout also runs inside
that lock, so a save can never fall between them. The pull reads every
uncommitted local edit before the checkout and writes it back after it.
When both sides changed a text file, the conflict ladder resolves it with
the incoming version. Otherwise the edit is kept beside a conflict copy.
The result stays uncommitted for the next commit. Local edits captured
before a checkout are saved in `refs/reflect/edits` until they are written
back, so a failure or a stop in the write-back cannot lose them.

- Test: `git::tests::a_save_between_commit_and_merge_survives_the_merge`,
  `git::tests::a_save_between_commit_and_fast_forward_survives`,
  `git::tests::edits_after_a_crash_before_checkout_keep_the_merged_changes`.

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

## S3. After any failed git command, the next cycle loses nothing

Whatever step fails (lock file, disk, network, crash), running the normal
cycle again (commit, fetch, merge, push) converges on a tree that contains
every local and every remote change. In particular it never pushes a commit
that reverts a pull.

- Test: `git::tests::fast_forward_failure_before_the_ref_moves_converges_next_cycle`,
  plus every S2 and S5 test.

## S4. One git command at a time per graph

Git commands, note writes, and iCloud sweep writes on the same graph are
serialized. The quit-time and background flush go through the sync engine's
queue, never straight to `git_commit_all`.

- Test: `git::tests::commit_during_fast_forward_never_reverts_pulled_notes`,
  `backup-service.test.ts` "quit flush waits for an in-flight pull before
  committing", `engine.test.ts` "commitNow joins the single-flight queue
  and never touches the network".

## S5. The repository is never left in app-made merge state

A pull computes the merge in memory and never calls `repo.merge()`, so no
stop can leave `MERGE_HEAD` behind. Until the branch ref moves, the merge
commit is recorded in `refs/reflect/merge`, and the next commit or pull
checks it out and moves the ref to it instead of merging again. Foreign
state (a merge or rebase the user started with the git CLI) is still
refused.

Reserved refs: `refs/reflect/merge` holds a merge commit written before its
checkout, and the next cycle adopts it. `refs/reflect/edits` holds local
edits captured before a checkout, and the next cycle replays them if the
write-back did not finish.

- Test: `git::tests::merge_interrupted_before_commit_converges_next_cycle`,
  `git::tests::merge_never_leaves_merge_head`,
  `git::tests::edits_after_a_merge_crash_survive_the_next_cycle`,
  `git::tests::edits_after_a_crash_before_checkout_keep_the_merged_changes`,
  `git::tests::a_recorded_merge_from_a_foreign_head_is_dropped`.

## S6. `.reflect/` never enters a commit

The runtime directory is excluded by `.gitignore`, by an in-memory ignore
rule, and by removing entries an older repository already
tracked.

- Test: `git::tests::commit_excludes_reflect_and_skips_when_clean` (untracked
  files), `git::tests::tracked_reflect_entries_are_dropped_from_the_next_commit`
  (entries an adopted repository already tracked).

## S7. Merged content is committed and pushed, never left pending

A text file both devices changed is resolved by the conflict ladder
(`conflict::ladder`), committed with both parents, and pushed. The ladder
orders the sides by commit time and content, so both devices produce the
same bytes. A binary file keeps both copies and an edit kept against a
deletion stays, and only those land in `reviewPaths`. Other notes keep
syncing.

- Test: `git::tests::conflicting_edits_merge_without_markers`,
  `git::tests::daily_append_on_two_devices_merges_by_union`,
  `git::tests::frontmatter_only_conflict_merges_keywise`,
  `git::tests::both_devices_resolve_the_same_pair_to_the_same_bytes`,
  `git::tests::a_deletion_beside_an_append_is_reconciled_not_resurrected`,
  `git::tests::a_dirty_save_against_an_overlapping_pull_merges_through_the_ladder`,
  `git::tests::edit_vs_delete_keeps_the_edit`,
  `git::tests::binary_conflict_keeps_both_copies`,
  `git::tests::a_directory_file_conflict_keeps_the_file_as_a_conflict_copy`,
  `git::tests::a_symlink_conflict_keeps_both_sides`.

## S8. Edits in an open note are never silently discarded

When external content arrives while the buffer has unsaved edits, the
session saves at once. The save is a checked write against the disk text
the buffer was typed on, and `note_write` merges it with the newer disk
text under the graph lock (merge-on-write). The session always adopts the
ladder's result; a result the editor cannot round-trip opens the note
protected. There is no parked state, so every
exit path only has to finish the write.

- Test: `fs::tests::a_checked_write_against_a_moved_file_merges_under_the_lock`,
  `fs::tests::a_reconciled_write_archives_the_buffer`;
  `note-session-service.test.ts` "a dirty buffer saves at once when an
  external change arrives", "an exact merge adopts the merged text and the
  session is clean", "a reconciled merge adopts the merged text and stays
  saveable", "a lossy merged result opens protected", "a merged title change is
  reported as external before saved", "keystrokes during a merging write
  stay dirty and merge on the next write", "dispose after flush still
  completes a merging write".

## S9. Merges never write conflict markers

No merge path writes `<<<<<<<` lines into a note: not the git pull, not
the iCloud sweep, not the editor save. All three resolve a text conflict
through the same ladder. A result that drops or interleaves a side is
handled by where each side lives. A Git pull keeps both sides in the
parents of the merge commit, so it archives nothing. An iCloud sweep or an
editor save archives a result that drops or interleaves a side under
Earlier versions. Conflict markers are plain text to Reflect: the app
neither writes nor interprets them.

- Test: `git::tests::conflicting_edits_merge_without_markers`,
  `conflict::ladder::tests::overlapping_edits_reconcile_without_markers`,
  `note-session-service.test.ts` "a dirty buffer saves at once when an
  external change arrives".
