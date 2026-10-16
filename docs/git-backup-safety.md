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
not clobbered by the checkout that applies the pull. Each cycle runs fetch,
then `git_pull`, then push. `git_pull` commits the local changes and merges
the remote under one graph lock. Every writer to a tracked file waits for
that lock, so no save can land between the commit and the checkout. At
checkout the working tree equals HEAD. `.reflect/` and files withheld for
size stay out of the checkout, so their local bytes stay as they are. A note
saved during the fetch is committed before the merge. S7 resolves any
conflict with the remote.

- Test: `git::tests::pull_all_holds_one_lock_for_commit_and_merge`,
  `git::tests::pull_all_commits_before_it_merges`,
  `git::tests::an_oversized_edit_survives_the_pull`.

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
cycle again (fetch, pull, push) converges on a tree that contains
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
stop can leave `MERGE_HEAD` behind. The app keeps no merge commit outside the
branch. If the user starts a merge, a rebase, or a detached HEAD with the git
CLI, the app clears the leftover state and sync continues. A detached HEAD
is reattached to the backup branch, and the working tree does not change.
Sync never stops with a message that asks the user to run git.

The stop points of a pull, and what the next cycle does:

| Stop point | Next cycle |
| --- | --- |
| Before the merge commit is written | Nothing is on disk. The pull runs again. |
| After the merge commit, before checkout | The working tree still equals HEAD, so nothing is committed. The merge runs again and makes the same bytes. The only cost is one unreferenced commit. |
| After checkout, before the branch ref moves | The working tree equals the merge tree. The next commit records it as a child of HEAD, and the merge with the remote runs again. Clean merges agree on both sides. A `.md` note that the ladder already resolved runs through the ladder again. The word-level merge can repeat a phrase, but it writes no marker and loses no word. |

- Test: `git::tests::merge_interrupted_before_commit_converges_next_cycle`,
  `git::tests::merge_never_leaves_merge_head`,
  `git::tests::a_leftover_cli_merge_state_is_cleared_not_refused`,
  `git::tests::a_detached_head_is_reattached_to_the_backup_branch`.

## S6. `.reflect/` never enters a commit

The runtime directory is excluded by `.gitignore`, by an in-memory ignore
rule, and by removing entries an older repository already
tracked.

- Test: `git::tests::commit_excludes_reflect_and_skips_when_clean` (untracked
  files), `git::tests::tracked_reflect_entries_are_dropped_from_the_next_commit`
  (entries an adopted repository already tracked).

## S7. Merged content is committed and pushed, never left pending

Each file that both devices changed resolves by one row of this table. The
app commits the result with both parents and pushes it. Other notes keep
syncing.

| Case | Result |
| --- | --- |
| One side changed the file, the other side deleted it | Keep the changed side. |
| Both sides changed it, and the three-way merge is clean | Use the merged result. |
| Both sides changed a `.md` note, and the merge is not clean | Run the conflict ladder (`conflict::ladder`). It always returns text. |
| Both sides changed another file, and the merge is not clean or the file is binary | Keep the local file at its path. Write the remote version beside it as `<stem> (conflict <UTC time> <hash8>).<ext>`. |

Other text files try a three-way merge (`conflict/merge3.rs`) before the last
row applies. The UTC time is the commit time of the remote side. `hash8` is
the first 8 hex digits of the blob hash of the remote version. If that name
is taken, a counter is added before the extension, for example
`(conflict 2026-10-16 08-05-31 a1b2c3d4 2)`. Symlinks and submodules keep both
sides. The ladder orders the sides by commit time and content, so both devices
produce the same bytes.

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

When external content arrives while the buffer has unsaved edits, the
session saves at once. The save is a checked write against the disk text
the buffer was typed on, and `note_write` merges it with the newer disk
text under the graph lock (merge-on-write). The session always adopts the
ladder's result; a result the editor cannot round-trip opens the note
protected. There is no parked state, so every
exit path only has to finish the write.

- Test: `fs::tests::a_checked_write_against_a_moved_file_merges_under_the_lock`,
  `fs::tests::a_reconciled_write_keeps_both_words`;
  `note-session-service.test.ts` "a dirty buffer saves at once when an
  external change arrives", "an exact merge adopts the merged text and the
  session is clean", "a lossy merged result opens protected", "a merged title change is
  reported as external before saved", "keystrokes during a merging write
  stay dirty and merge on the next write", "dispose after flush still
  completes a merging write".

## S9. Merges never write conflict markers

No merge path writes `<<<<<<<` lines into a note: not the git pull, not
the iCloud sweep, not the editor save. A `.md` note resolves through the
conflict ladder on all three paths. Other files keep a conflict copy when
they do not merge cleanly (S7). Conflict markers are plain text to Reflect:
the app neither writes nor interprets them.

- Test: `git::tests::conflicting_edits_merge_without_markers`,
  `conflict::ladder::tests::overlapping_edits_reconcile_without_markers`,
  `note-session-service.test.ts` "a dirty buffer saves at once when an
  external change arrives".
