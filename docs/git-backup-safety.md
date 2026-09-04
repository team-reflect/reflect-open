# Git backup and recovery

GitHub and generic Git remotes use the same native commit, fetch, merge, and
push implementation. Local history commits happen before credential refresh,
so an authentication or network failure does not prevent local snapshots.

## Saves during sync

Fetch and push serialize repository operations without holding the graph's
filesystem mutation lock. Note saves continue during those network waits.
Immediately before applying a pull, Reflect takes the mutation lock, commits
saves that have reached disk, and holds the lock through merge and checkout.
Note saves, note creation/deletion/renames, asset promotion, import finalization,
and native conflict sweeps use that same lock. Waiting saves run off the main
thread and continue after checkout.

Overlapping committed note edits become labeled conflict markers. Both original
versions remain in the merge commit's parents. A save queued during checkout
lands afterwards, with the pulled version retained in Git history. The editor
re-reads a disk notification if a local save completed while its read was pending.

Merge results are computed in memory. Checkout uses libgit2's safe mode and does
not overwrite ignored files. Branch references advance only after checkout and
index writes succeed. A conflicting dirty path causes an error with the local
file preserved. Reflect does not force-reset the working tree on failure. An I/O
failure can leave partially applied files or a preserved conflict copy; the old
branch remains reachable, and subsequent snapshots retain the files on disk.
External filesystem tools do not participate in Reflect's in-process lock, so
safe checkout is an additional check, not a filesystem transaction across other
processes.

## Attachments and runtime files

Binary conflicts keep the local attachment and atomically claim a separate file
for the remote attachment. Names progress from `image (conflict).png` to
`image (conflict 2).png`, and so on. Existing files are never reused for a new
conflict. A copy retained after a later sync failure is deliberate recovery data.
The size limit also applies to files staged by another Git tool before Reflect
runs; withheld updates retain their previous committed version.

The root `.reflect` directory (including case variants and trailing-dot/space
filename aliases) is excluded from new Reflect commits and incoming checkouts,
even when an adopted repository already tracks it. Adoption removes its entries
from the Git index without deleting local files. Restoring through Reflect does
not check out another device's runtime files. Local SQLite data and durable chat
history stay on the device.

This does not rewrite existing Git history: runtime data already committed in
older revisions remains in those revisions. Durable chat history is not part of
Git backup, and rebuilding the note index must preserve it.

## Interrupted operations

A queued command rechecks the graph generation after acquiring its lock. Stopping
or replacing a backup controller prevents later commands from the old cycle;
an already-running native command can finish. Disconnect waits behind repository
operations before removing the remote. Reflect refuses to adopt or commit an
unfinished external Git operation or an index containing unresolved conflicts.
