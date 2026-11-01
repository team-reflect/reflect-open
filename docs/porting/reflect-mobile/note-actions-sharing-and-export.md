# Porting note actions, sharing, and export

**v2 status: v1 for pin / share / trash (the 2026-06-12 product call,
implemented in `apps/desktop/src/mobile/note-actions-menu.tsx`);
publishing deferred product-wide; JSON export superseded.**

## What V1 mobile does

### Note actions

Each note has an options popover (desktop V1's context sidebar reduced to
actions; no suggested backlinks, similar notes, or contacts on mobile):

- **Pin / Unpin**: sets `pinnedIndex`; pinned notes sort first in All Notes
  and are a search filter.
- **Share**: the iOS share sheet (`@capacitor/share`) with the note's
  **markdown** and title.
- **Publish / Copy public URL / Unpublish**: toggles the public flag for a
  shareable web URL (paid-gated).
- **Move to trash**: soft delete.

### Export

From the profile modal, **Export notes** writes a whole-graph JSON export
(`mobile-reflect-<graphname>-<timestamp>.json`) to the cache directory and
hands it to the share sheet (`client/screens/profile/export-item.tsx`). No
per-note markdown export on mobile.

## What changes in v2, and why

- **Pin** is the frontmatter `isPinned` flag (as on desktop), written
  through the session-or-disk channel.
- **Share** uses `navigator.share`, verified working in the Tauri iOS
  WKWebView, so no native plugin. The payload is the file's markdown.
- **Trash** goes to graph-local `.reflect/trash/` (recoverable,
  sync-ignored) instead of a soft-delete flag or desktop's OS trash
  (`NoteActionsService.trash` in
  `packages/core/src/documents/note-actions-service.ts`).
- **Publish is not ported**: it conflicts with local-first files and is
  deferred product-wide ([product vision](../../reflect-v2-product-vision.md)).
- **JSON export is superseded**: the workspace is plain markdown in
  `Documents/`, visible in Files, so no export step is needed. Whole-graph
  export formats stay a desktop concern under the portability plan.

## V1 → v2 mapping

| V1                                      | v2                                                          |
| --------------------------------------- | ------------------------------------------------------------ |
| Pin/unpin (`pinnedIndex`)               | Frontmatter `isPinned` via the shared note-flag path         |
| Share sheet with markdown               | `navigator.share` with the file's markdown                   |
| Publish / public URL / unpublish        | Not ported (publishing deferred product-wide)                |
| Move to trash (soft delete)             | Move to `.reflect/trash/`                                    |
| Whole-graph JSON export via share sheet | Superseded: Files-app-visible markdown workspace             |
| Options popover per note                | `note-actions-menu.tsx` (pin, share, trash)                  |
