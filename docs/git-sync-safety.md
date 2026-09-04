# Git sync safety and recovery

## Mutation contract

Fetch and push do not hold the graph filesystem gate. Editing remains enabled
while the network runs. Commits and merge installation take an exclusive gate
keyed by the canonical graph root, shared across windows. Native note writes,
creation, renames, deletion, and screenshot writes participate in that gate.
A save attempted during installation fails promptly rather than blocking the
UI; the unsaved editor buffer remains available to retry.

The native merge checks for pending local changes after acquiring the gate.
An edit saved during fetch produces a no-write `worktreeChanged` result.
The engine snapshots those edits and retries the already-fetched merge, with
three attempts maximum. It never forces a dirty worktree to match the remote.
Stopped engines issue no new command after the current command boundary.
An already-issued command may finish on its captured old root, never the new
graph's root.

Merge calculation and conflict resolution use an in-memory index. Installation
locks HEAD, the branch, and the Git index, checks the expected state, and moves
HEAD only after the files and index are installed. Existing files are moved
aside, not truncated. New files use atomic no-clobber claims. Every changed
path is checked again immediately before installation, and the moved original
is checked before its replacement is claimed.

Other applications do not honor Reflect's in-process gate. A concurrent atomic
save either remains at its path or makes installation refuse. Writes through
an already-open descriptor remain in the moved original, even after installation
finishes. Recovery copies are deliberately retained, including on success;
there is no automatic age-based deletion that could erase a delayed writer.
On a failed multi-file installation, originals are restored without clobbering
new arrivals; displaced files are retained too.

The installer refuses symlinks, submodules, repository-metadata paths, and
incompatible file/directory shapes rather than guessing. It installs raw Git
blob bytes, without invoking external checkout filters. A working copy changed
by Git filters (for example CRLF conversion) can refuse the byte-level check;
the original is preserved. Concurrent directory restructuring by other tools
is not coordinated; pause those tools before retrying a refusal.

## Conflicts and runtime data

Text conflicts commit both versions with `this device` / `other device`
markers. Edit/delete conflicts retain the edit. Binary conflicts retain the
local attachment and choose `name (conflict).ext`, then
`name (conflict 2).ext`, etc. Existing files and names in the merged index
are reserved; the final no-clobber claim also protects against a late arrival.
Existing references are not rewritten.

The root `.reflect` directory is excluded from every new commit and merged
tree, even if an adopted repository previously tracked it. Removing an index
entry never deletes the local file. Pull installation also excludes runtime
deletions, and restore skips the remote runtime before opening the graph.
An open SQLite database, WAL, and durable chat tables therefore remain local.
Sanitizing a fetched tree creates a normal descendant commit so the exclusion
can be pushed without rewriting history.

Previously published runtime bytes still exist in old Git history. This
change does not rewrite or purge that history.

## Recovery

Recovery lives under the repository's actual Git directory:
`reflect-sync/checkout-*/` (normally `<graph>/.git/reflect-sync/`).
Each directory contains:

- `manifest.json`: branch, before/after commits, and affected paths.
- `original/<path>`: original file inodes moved out of the working tree.
- `displaced/<path>`: files moved aside during failed-install rollback.
- `index-before` and, when prepared, `index-after`.

An ordinary failure rolls back the index and installed files, leaving HEAD
unchanged and the repository usable. The error includes the recovery location.
Check both the working copy and recovery files before retrying.

A process interruption or failed rollback leaves `reflect-sync/pending`.
Subsequent setup/commit/merge operations refuse rather than commit a partial
pull as local edits. Close Reflect and stop other writers. Back up the entire
graph, including its Git directory, then inspect the manifest, current HEAD,
index, original files, and displaced files. Restore the desired versions
without overwriting any newer edits. Only after the repository is consistent,
remove the pending marker and any stale Git lock files belonging to the
interrupted process. Do not use `git reset --hard` to dismiss the error.

Recovery archives can be removed manually after all writers have stopped and
their contents have been checked. They are local-only and are not pushed.
