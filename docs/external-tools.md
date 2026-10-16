# Writing notes from other tools

How scripts and other editors can write to a Reflect graph. A graph is a folder of
plain Markdown files, so any tool can read and write them.

## What is safe

- **Append to a note at any time.** Reflect keeps both tails, oldest first. This is
  the safest edit, and it works for any note, not only daily notes.
- **Edit while Reflect is open.** If your edit overlaps an edit made in Reflect,
  Reflect merges the two word by word. It never writes conflict markers into the
  note.
- **Both versions are kept.** When a merge drops or interleaves a side, Reflect
  archives both versions. Find them under **Earlier versions** in the note sidebar.
- **Folding a bullet does not cause a conflict.** You can fold a bullet in Reflect
  while a script appends to the same note. Reflect keeps both changes and shows no
  conflict notice.
- **Write a whole file atomically.** Write to a temporary file and rename it, so
  Reflect never reads a half-written note.

## What Reflect does not sync

- **`.reflect/` is never synced.** Git ignores it and iCloud keeps it local-only.
  The index, the merge bases and the archive of earlier versions live there. Do not
  write notes inside it.
- **Binary assets do not text-merge.** If two devices change the same asset, the
  other copy lands beside it as `name (conflict).ext`.

## Notes that already hold markers

An older version of Reflect could leave `<<<<<<<` markers in a note. Reflect opens
such a note protected and offers to keep either side or both. Your tool can also
edit the markers out by hand.

See also: [iCloud sync](icloud-sync.md) for the conflict ladder, and
[Git backup safety](git-backup-safety.md) for the rules the sync path keeps.
