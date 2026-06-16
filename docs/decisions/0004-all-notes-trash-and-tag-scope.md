# TDR 0004 — All Notes: OS-native trash, no in-app trash view or tag manager

- **Status:** Accepted
- **Date:** 2026-06-15
- **Scope:** The delete/restore model and tag management of the V2 **All Notes**
  screen (`apps/desktop/src/components/all-notes/`). Concerns the surface's UI
  affordances only — the on-disk delete mechanism (`note_delete` → OS trash) is
  unchanged.
- **Decision driver:** The V1 reference doc
  ([reflect-v1-all-notes.md](../reflect-v1-all-notes.md)) recommends two V2
  additions — an in-app **restore from trash** action and (carried from V1) an
  inline **delete-tag** affordance. While building selection + bulk-trash for
  All Notes we decided to ship **neither**. This record captures why, so the
  declined recommendations don't read as oversights.

---

## TL;DR

**All Notes will not get an in-app Trash view or a Restore action, and will not
get a tag-management (delete/rename a tag globally) UI.** Both capabilities
already exist through a more durable path the user already trusts:

- **Trash/restore → the operating system.** A desktop delete already moves the
  note's `.md` file to the OS-native trash. The OS provides the browse-and-
  restore UI; restoring the file drops it back in the graph and the watcher
  re-indexes it, so it reappears in All Notes on its own. An in-app trash
  browser would duplicate that and create a second, divergent recovery path.
- **Tag delete → edit the notes.** Tags aren't first-class objects; a tag exists
  only because some note body carries it. Remove it from the notes and it
  disappears from the filters automatically. A "delete tag" button would be a
  bulk content rewrite disguised as a filter chip.

---

## Decision 1 — Deletes go to the OS trash; no in-app Trash view or Restore

A note deleted from the desktop app is sent to the **OS-native trash**, not a
hard delete and not an app-managed trash folder. This is already how the code
works: `deleteNote` calls the `note_delete` command, which uses the `trash`
crate to move the file to the platform trash (recoverable, and ignored by sync).
See [`apps/desktop/src-tauri/src/fs/mod.rs`](../../apps/desktop/src-tauri/src/fs/mod.rs)
(`note_delete`) and [`packages/core/src/graph/commands.ts`](../../packages/core/src/graph/commands.ts)
(`deleteNote`).

**Why no in-app Trash view + Restore:**

- **The OS already is the trash view.** Finder / File Explorer already list and
  restore trashed files, with retention, "put back", and empty-trash semantics
  the user understands. We would be reimplementing a worse version of a tool
  they already have.
- **Restore is automatic, not a feature we have to build.** Because the index is
  a rebuildable projection of the markdown files, restoring a `.md` from the OS
  trash back into the graph folder is observed by the file watcher, re-indexed,
  and the note reappears in All Notes with no app involvement. There is nothing
  to "restore" in the app — the app converges on the files.
- **One recovery path, not two.** An in-app trash that shadows the OS trash
  invites drift (a note "restored" in one but not the other) and a second mental
  model for where deleted notes live.

**Mobile note.** Mobile has no OS trash, so `note_delete` there moves files into
the graph-local `.reflect/trash/` instead (Plan 19) — the same recoverability
promise by a different mechanism. An in-app browser for *that* folder is out of
scope for this decision and can be revisited if mobile needs it; it does not
change the desktop All Notes scope.

This **overrides** the recommendation in
[reflect-v1-all-notes.md](../reflect-v1-all-notes.md) ("Add a real restore from
trash action; V1 only supports permanent destruction").

## Decision 2 — No in-app global tag delete/rename from the filter UI

V1's "Custom" tag dropdown carried an inline ✕ that deleted a tag from the whole
graph (after a confirm). V2's All Notes **does not** port this, and adds no
tag-rename UI either.

**Why:**

- **Tags are derived, not owned.** A tag is not a stored entity with its own
  lifecycle; it's a projection over note bodies (the `tags` table is rebuilt
  from `#tag` tokens in markdown). The canonical way to remove a tag is to stop
  writing it: edit it out of the notes that carry it, and when the last note
  drops it, the tag vanishes from the facet list and the filter bar on its own.
- **A "delete tag" button hides a bulk content mutation.** To actually delete a
  tag globally, the app would have to rewrite every note carrying it — a
  many-file content edit triggered from a small filter chip. That's a surprising
  amount of destructive power behind an unassuming control, and it conflicts with
  "markdown is the source of truth": the notes, not a tag registry, decide which
  tags exist.

**Consequence for the UI:** the All Notes filter bar (`all-notes-filters.tsx` /
`custom-filter-menu.tsx`) is select-only. There is no tag CRUD here.

---

## Consequences

- All Notes ships **selection + keyboard navigation + a bulk "Trash" action**
  (to the OS trash); it does **not** ship a Trash route, a restore command, or
  any tag-management UI.
- The single-note trash action (`note-trash-action.tsx`) and the new bulk action
  share the same `deleteNote` → OS-trash path; there is one delete mechanism.

## Follow-ups

- The frontend comment in
  [`apps/desktop/src/lib/note-delete.ts`](../../apps/desktop/src/lib/note-delete.ts)
  still describes the delete as moving into `.reflect/trash/`. That is the
  *mobile* behavior; on desktop it is the OS trash. The comment (and the
  "graph trash" wording in the trash-confirm dialog) should be corrected to match.
