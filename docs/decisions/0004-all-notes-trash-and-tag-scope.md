# TDR 0004 — All Notes: OS-native trash, no in-app trash view or tag manager

- **Status:** Accepted
- **Date:** 2026-06-15
- **Scope:** The delete/restore model and tag management of the V2 **All Notes**
  screen (`apps/desktop/src/components/all-notes/`). UI affordances only; the
  on-disk delete (`note_delete` → OS trash) is unchanged.
- **Decision driver:** [reflect-v1-all-notes.md](../reflect-v1-all-notes.md)
  recommends an in-app **restore from trash** action and (carried from V1) an
  inline **delete-tag** affordance. While building selection + bulk-trash we
  decided to ship **neither**. This record says why, so they do not read as
  oversights.

---

## TL;DR

**All Notes gets no in-app Trash view or Restore action, and no global tag
delete/rename UI.** Both capabilities exist through a more durable path:

- **Trash/restore → the operating system.** A desktop delete moves the `.md`
  file to the OS trash. Restoring it puts it back in the graph, the watcher
  re-indexes it, and it reappears in All Notes.
- **Tag delete → edit the notes.** A tag exists only because a note body carries
  it. A "delete tag" button would be a bulk content rewrite disguised as a
  filter chip.

---

## Decision 1 — Deletes go to the OS trash; no in-app Trash view or Restore

A desktop delete goes to the **OS-native trash** (the `trash` crate in
`note_delete`, [`apps/desktop/src-tauri/src/fs/mod.rs`](../../apps/desktop/src-tauri/src/fs/mod.rs),
called by `NoteFileService.delete` in
[`packages/core/src/graph/note-file-service.ts`](../../packages/core/src/graph/note-file-service.ts)).
It is recoverable and ignored by sync.

**Why no in-app Trash view + Restore:**

- **The OS already is the trash view.** Finder / File Explorer list and restore
  trashed files, with retention, "put back" and empty-trash semantics users
  understand.
- **Restore needs no feature.** The index is a projection of the files, so a
  restored `.md` is seen by the watcher and re-indexed. The app converges on
  the files.
- **One recovery path, not two.** An in-app trash shadowing the OS trash invites
  drift and a second mental model for where deleted notes live.

**Mobile note.** Mobile has no OS trash, so `note_delete` moves files into the
graph-local `.reflect/trash/` (Plan 19), the same recoverability by another
mechanism. An in-app browser for that folder is out of scope here and can be
revisited for mobile.

This **overrides** the recommendation in
[reflect-v1-all-notes.md](../reflect-v1-all-notes.md) ("Add a real restore from
trash action; V1 only supports permanent destruction").

## Decision 2 — No in-app global tag delete/rename from the filter UI

V1's "Custom" tag dropdown had an inline ✕ that deleted a tag from the whole
graph after a confirm. V2 does not port it and adds no tag-rename UI.

**Why:**

- **Tags are derived, not owned.** The `tags` table is rebuilt from `#tag`
  tokens in markdown. To remove a tag, edit it out of the notes; when the last
  note drops it, it vanishes from the filters.
- **A "delete tag" button hides a bulk content mutation.** Deleting a tag
  globally means rewriting every note that carries it, from a small filter chip.
  That is surprising destructive power, and it conflicts with "markdown is the
  source of truth": the notes, not a tag registry, decide which tags exist.

**Consequence for the UI:** the filter bar (`all-notes-filters.tsx` /
`custom-filter-menu.tsx`) is select-only.

---

## Consequences

- All Notes ships **selection + keyboard navigation + a bulk "Trash" action**
  (to the OS trash), with no Trash route, restore command or tag-management UI.
- The single-note trash action (`note-trash-action.tsx`) and the bulk action
  share one delete path.

## Follow-ups

- Done: an old frontend comment described the delete as moving into
  `.reflect/trash/` (the mobile behavior). The comment now lives on
  `NoteActionsService.trash` and names both destinations, and the confirm
  dialog no longer says "graph trash".
