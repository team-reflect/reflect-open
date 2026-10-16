# Git backup safety invariants

The rules every change to the sync path must keep. "The sync path" is
`apps/desktop/src-tauri/src/git/`, `packages/core/src/sync/`, the backup
flusher in `packages/core/src/graph/persistence-flush-service.ts`, and the
external-change handling in
`packages/core/src/documents/note-session-service.ts`.

Each rule names the tests that enforce it.

## S1. A pull never overwrites uncommitted local changes

`git_pull` commits local changes and merges the remote under one graph lock,
and its checkout is safe, not forced, so a write from outside the lock fails
the pull and the next cycle commits it.

- Test: `git::tests::pull_all_holds_one_lock_for_commit_and_merge`,
  `git::tests::pull_all_commits_before_it_merges`,
  `git::tests::an_oversized_edit_survives_the_pull`,
  `git::tests::a_write_during_the_merge_survives_the_checkout`.

## S2. The branch ref moves only after the working tree matches it

A failure between the checkout and the ref move makes the next cycle retry
the pull instead of committing a stale tree.

- Test: `git::tests::fast_forward_checkout_failure_never_reverts_pulled_notes`,
  `git::tests::stale_head_lock_fast_forward_never_reverts_pulled_notes`,
  `git::tests::fast_forward_with_a_stale_head_lock_succeeds`,
  `git::tests::merge_crash_before_checkout_converges_next_cycle`,
  `git::tests::merge_crash_after_checkout_before_ref_move_converges_next_cycle`.

## S3. After any failed git command, the next cycle loses nothing

The next normal cycle converges on a tree with every local and remote
change, and never pushes a commit that reverts a pull.

- Test: `git::tests::fast_forward_failure_before_the_ref_moves_converges_next_cycle`,
  plus every S2 and S5 test.

## S4. One git command at a time per graph

Git commands, note writes, and iCloud sweep writes on one graph are
serialized. The quit-time and background flush go through the sync engine's
queue, never straight to `git_commit_all`.

- Test: `git::tests::commit_during_fast_forward_never_reverts_pulled_notes`,
  `backup-service.test.ts` "quit flush waits for an in-flight pull before
  committing", `engine.test.ts` "commitNow joins the single-flight queue
  and never touches the network".

## S5. The repository is never left in app-made merge state

A pull merges in memory and never calls `repo.merge()`. The app clears a
merge, rebase, or detached HEAD left by the git CLI, so sync never asks the
user to run git.

- Test: `git::tests::merge_interrupted_before_commit_converges_next_cycle`,
  `git::tests::merge_never_leaves_merge_head`,
  `git::tests::a_leftover_cli_merge_state_is_cleared_not_refused`,
  `git::tests::a_detached_head_is_reattached_to_the_backup_branch`.

## S6. `.reflect/` never enters a commit

`.gitignore`, an in-memory ignore rule, and dropping entries an adopted
repository already tracks keep the runtime directory out.

- Test: `git::tests::commit_excludes_reflect_and_skips_when_clean`,
  `git::tests::tracked_reflect_entries_are_dropped_from_the_next_commit`.

## S7. Merged content is committed and pushed, never left pending

An edit beats a delete. A `.md` note runs the conflict ladder
(`conflict::ladder`). Another file takes a clean three-way merge, or keeps
the local file and writes the remote version beside it as
`<stem> (conflict <UTC time> <hash8>).<ext>`. Both devices produce the same
bytes and names, so they converge.

- Test: `git::tests::conflicting_edits_merge_without_markers`,
  `git::tests::daily_append_on_two_devices_merges_by_union`,
  `git::tests::frontmatter_only_conflict_merges_keywise`,
  `git::tests::both_devices_resolve_the_same_pair_to_the_same_bytes`,
  `git::tests::a_deletion_beside_an_append_is_reconciled_not_resurrected`,
  `git::tests::a_text_conflict_that_diff3_merges_takes_the_merge`,
  `git::tests::edit_vs_delete_keeps_the_edit`,
  `git::tests::a_json_conflict_keeps_both_copies`,
  `git::tests::a_md_conflict_never_gets_a_copy`,
  `git::tests::binary_conflict_keeps_both_copies`,
  `git::tests::two_devices_name_the_same_copy`,
  `git::tests::a_conflict_copy_never_overwrites_an_existing_file`,
  `git::tests::a_directory_file_conflict_keeps_the_file_as_a_conflict_copy`,
  `git::tests::a_symlink_conflict_keeps_both_sides`,
  `backup-service.test.ts` "a hint lists every copy by its graph path".

## S8. Edits in an open note are never silently discarded

An external change to a dirty buffer saves it at once as a checked write,
which `note_write` merges with the disk text under the graph lock. A result
the editor cannot round-trip opens the note protected.

- Test: `fs::tests::a_checked_write_against_a_moved_file_merges_under_the_lock`,
  `fs::tests::a_reconciled_write_keeps_both_words`;
  `note-session-service.test.ts` "a dirty buffer saves at once when an
  external change arrives", "an exact merge adopts the merged text and the
  session is clean", "a lossy merged result opens protected", "a merged title
  change is reported as external before saved", "keystrokes during a merging
  write stay dirty and merge on the next write", "dispose after flush still
  completes a merging write".

## S9. Merges never write conflict markers

No merge path (git pull, iCloud sweep, editor save) writes `<<<<<<<` lines.
Markers already in a file are plain text.

- Test: `git::tests::conflicting_edits_merge_without_markers`,
  `conflict::ladder::tests::overlapping_edits_reconcile_without_markers`,
  `note-session-service.test.ts` "a dirty buffer saves at once when an
  external change arrives".
