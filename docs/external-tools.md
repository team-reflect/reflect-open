# Writing notes from other tools

How scripts and other editors can write to a Reflect graph. A graph is a folder of
plain Markdown files, so any tool can read and write them.

## What is safe

- **Append to a note at any time.** Reflect keeps both tails, oldest first. This is
  the safest edit, and it works for any note, not only daily notes.
- **Edit while Reflect is open.** If your edit overlaps an edit made in Reflect,
  Reflect merges the two word by word. It never writes conflict markers into the
  note.
- **Both versions are kept.** A Git graph keeps earlier versions in the Git
  history. A note that both sides changed merges word by word, so no word is
  lost. Any other file that both sides changed keeps a copy beside it, named
  `name (conflict <YYYY-MM-DD HH-MM-SS> <hash8>).ext`.
- **Folding a bullet does not cause a conflict.** You can fold a bullet in Reflect
  while a script appends to the same note. Reflect keeps both changes and shows no
  conflict notice.
- **Write a whole file atomically.** Write to a temporary file and rename it, so
  Reflect never reads a half-written note.

## What Reflect does not sync

- **`.reflect/` is never synced.** Git ignores it and iCloud keeps it local-only.
    The index and the merge bases live there. Do not write notes inside it.
- **Files other than notes do not text-merge.** If two devices change the same
  file, the other copy lands beside it as
  `name (conflict <YYYY-MM-DD HH-MM-SS> <hash8>).ext`.
- **A Git merge or rebase started with the git CLI is cleared.** Reflect cleans up
  an unfinished merge or rebase in a Git graph, and reattaches a detached HEAD to
  the backup branch. Then sync continues. Conflict markers that the CLI left in a
  file are committed as plain text.

## Notes that already hold markers

An older version of Reflect could leave `<<<<<<<` markers in a note. Reflect treats
markers as plain text. It does not write them and does not interpret them. Edit
the markers out by hand, in Reflect or in your tool.

See also: [iCloud sync](icloud-sync.md) for the conflict ladder, and
[Git backup safety](git-backup-safety.md) for the rules the sync path keeps.
