# Readable filenames & note identity

Regular notes Reflect creates live at `notes/<slug>.md`, where the slug derives
from the title: "Meeting Notes" is `notes/meeting-notes.md`, and when the title
changes, the file follows. An opened Markdown vault can also contain adopted
notes at the root or in visible nested folders. Reflect edits those in place:
retitles keep known wiki links and title-mirroring displays current, but never
move the file (Plan 17).

Three rules make the system hang together:

1. **A managed filename is a projection of the title.** The title lives in
   content (the first H1, or frontmatter `title:`). There is no "rename file"
   UI: retitle the note and the filename follows. This applies only to a
   direct `notes/*.md` file with a valid Reflect ULID `id`.
2. **The frontmatter `id` is the durable identity.** Every note Reflect creates
   carries `id: <lowercase ulid>`. Filenames change; the id never does. It lets
   the index recognize a file that moved while Reflect wasn't looking, and it
   exposes sync forks (two files claiming one id).
3. **Wiki links carry titles, not paths.** `[[Meeting Notes]]` resolves at query
   time against title/alias keys, so a file rename breaks zero links by
   construction. Everything below is cheap *because* links never reference
   filenames.

Daily notes are untouched: `daily/YYYY-MM-DD.md` is already the readable
contract.

## The slug

`slugForTitle` (`packages/core/src/markdown/slug.ts`) defines the rules. Two
properties are load-bearing:

- **Lowercase-only output** makes APFS/NTFS case-insensitivity and git
  case-sensitivity agree: `Meeting.md` vs `meeting.md` can never fight because
  Reflect only writes the latter.
- **The 60-code-point cap** keeps worst-case 4-byte letters inside the
  255-byte basename limit, with room for `notes/`, `.md`, and a suffix.

The rules are **frozen** by a golden corpus in `slug.test.ts`. Changing any
output is a rename storm across every graph, so a failure there is a
breaking-change gate, not a test to update casually.

Collisions take a numeric suffix (`meeting-2.md`, `-3`, …). The probe
(`packages/core/src/indexing/note-path-service.ts`) checks the index *and* the
disk, so a file the watcher hasn't indexed yet can't be clobbered. A note never
collides with itself, and `meeting-2.md` doesn't "tighten" to `meeting.md` when
it frees up.

## Birth

- **Created with a title** (`[[` create row, clicking an unresolved link): the
  file is born at its slug path.
- **Created untitled** (⌘N): the file gets a ULID placeholder name and reaches
  disk only when the user types. When the first title settles, a **birth**
  fires (a rename with `from: null`): no links to rewrite, no alias, the file
  just takes its slug.

## Rename: filenames follow settled titles

Only settled, in-app title changes to Reflect-managed notes move files. Sync
pulls, external edits, reconciles, rebuilds, and edits to adopted notes never
rename a file. That makes move loops with external tools impossible and keeps
vault layouts intact. Link maintenance and filename ownership are separate:
any editable regular note gets its links rewritten and its old title kept as
an alias.

A title settles after 5 seconds of quiet, or at once on blur, pane teardown,
or quit (`packages/core/src/documents/title-rename-tracker.ts`, Plan 07b).
The rename (`title-rename-service.ts`) then rewrites inbound links, aliases
the old title (so anything the rewrite missed still resolves), and moves the
file. Each phase fails independently with an honest report.

The move (`packages/core/src/documents/note-move-service.ts`) moves the index
rows in one transaction before it renames the file. `embedding_chunks` ride
along, so **a rename never re-embeds** (BYOK re-embeds cost the user money). A
failed file rename reverses the row move. Because the rows moved first, the
watcher's echo of the move is a no-op.

**An occupied destination always refuses**, db row or disk file. Nothing is
deleted or overwritten; the filename drifts until the next settled rename
retries. (Deliberate simplification, 2026-06-11: the race window is one IPC
round-trip behind a 5-second quiet gate.) Drift is cosmetic: resolution never
reads filenames.

After a move, the router rewrites history entries for the old path, so
back/forward never lands on a dead path. The pane adopts its retargeted
session (the editor is keyed on `sessionEpoch`, not the path), so cursor,
selection, and undo history survive (`packages/core/src/documents/document-binding.ts`).

## External renames heal by id

A rename in Finder, Obsidian, or a sync pull is recognized: a vanished indexed
row plus an unindexed file with the same `id` is a *move*, not a delete+create
(`packages/core/src/indexing/move-detection.ts`). Rows migrate, embeddings
survive, and any open session and route follow, as for an in-app rename. Both
the open-time reconcile and the live watcher heal.

Limits, all deliberate:

- **Ambiguous ids never pair.** Pairing could wire one note's history to
  another's file, so those stay sync forks.
- **Files without ids can't heal.** They fall back to delete+create, which
  always converges.
- **Split watcher batches degrade** to delete+create. In practice the debouncer
  groups rename halves.

## Sync

A rename reaches git as delete+add. Two-device tests in
`crates/git/src/tests.rs` pin the merge semantics:

- **Rename on one device + edit on another** converges: libgit2's rename
  detection lands the edit in the moved file.
- **Same title created on two devices offline** collides on one path and the
  conflict ladder merges it (impossible under ULID names; accepted as rare and
  recoverable).
- **One note retitled differently on two devices** forks into two files sharing
  one id. Both survive; the user copies any differing edits into one and
  deletes the other. `getDuplicateNoteIds` detects forks, but the app shows no
  UI for them: the term means nothing to a user, and the remedy is what they
  would do anyway.

## What deliberately doesn't exist

- **No ULID→slug migration.** Pre-launch there are no legacy graphs; a
  ULID-named note converts through birth/rename the next time it's titled.
- **No "rename file" UI.** The filename is derived.
- **No id-based routes.** Routes and the index stay path-keyed; the id is for
  reconciliation and fork detection.
- **No md-style link rewriting.** `[text](notes/foo.md)` links dangle after a
  rename. The `links` table records `kind = 'md'`, so a later pass can find
  them.
- A note with frontmatter `title:` can't be retitled from the editor (the H1
  isn't its title), so its filename only changes via external renames, which
  heal by id.

Plan and decision history: [docs/plans/17-readable-filenames.md](plans/17-readable-filenames.md).
