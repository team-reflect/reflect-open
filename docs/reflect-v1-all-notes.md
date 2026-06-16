# Reflect V1: "All Notes" Behavior

This document describes the **All Notes** view in Reflect V1, as a reference for the
V2 rewrite. All file paths in this document refer to the **V1 codebase**
(`~/repos/reflect`, a Next.js + MobX-Keystone app), not this repository.

For the broader product context, see [Reflect V1 Overview](./reflect-v1-overview.md).
This document zooms into one surface: the dense, table-style list of notes.

## What It Is

All Notes is a virtualized, table-style list of the graph's notes — one row per note,
showing subject, snippet, tags, and last-edited date. It serves two roles at once:

- **Library** — the canonical browseable index of every regular note.
- **Filtered result view** — clicking a tag (anywhere in the app) opens All Notes
  scoped to that tag; the built-in **Trash** view is the same component with a
  different query.

It is one of the main screens selected by `MainScreen.NoteList`, alongside Daily,
Tasks, Map, and Search.

## Routing and Entry Points

The view is reached through the app's route-state layer
(`client/core/router-view.ts`), which serializes app state to/from URLs:

- URL shape: `/g/:graphId/list` (no filter) or `/g/:graphId/list/:query` (filtered).
- The route carries `noteListQuery`, derived from `noteStore.listView.query`
  (`router-view.ts:60`). Applying a route calls `listView.setQuery(noteListQuery)`
  to restore the filter (`router-view.ts:105-107`).

Navigation methods on the main view (`client/models/main/main-view.ts`):

- `openListScreen()` — switch to the list and clear any filter (`main-view.ts:280`).
- `setAndOpenSearchQuery(query)` — set a filter and switch to the list
  (`main-view.ts:567`).
- `openNotesListForTag(tag)` — convenience wrapper that calls
  `setAndOpenSearchQuery('#' + tag)` (`main-view.ts:572`). This is what tag clicks
  throughout the app route into.

The view component itself is loaded client-side only via a Next.js dynamic import
(`client/screens/main/notes-list/notes-list-dynamic.tsx`), because it depends on
the browser-only virtualizer and local SQLite-backed model pool.

## The Query Model

All list behavior is driven by a single `query` string on the
`NoteListView` model (`client/models/note/note-list-view.desktop.ts`). The model
is a child of `NoteStore`, and its `query` field is a plain observable string
(`note-list-view.desktop.ts:21`).

`setQuery` has one notable behavior: re-setting the **same** query value does not
re-filter; it scrolls the list back to the top instead (`note-list-view.desktop.ts:125-132`).
This makes the toolbar buttons double as "scroll to top" when already active.

The query is interpreted into one of three SQL queries by the `notesQuery` getter
(`note-list-view.desktop.ts:70-81`):

| `query` value        | Resolves to                          | Meaning                                  |
| -------------------- | ------------------------------------ | ---------------------------------------- |
| `'#trash'`           | `deletedNotesDescQuery`              | Deleted notes, newest-deleted first      |
| starts with `'#'`    | `tagMatchNotesQuery`                 | Undeleted notes carrying that tag        |
| anything else (incl. `''`) | `regularNotesEditedDescQuery` | All regular (non-daily) undeleted notes  |

The three backing query builders live on `NoteStore`
(`client/models/note/note-store.ts`):

- `regularNotesEditedDescQuery` — `deletedAt IS NULL` **and `isDaily = 0`**, ordered
  by `coalesce(editedAt, updatedAt)` descending (`note-store.ts:277-279`,
  building on `regularNotesQuery` at `:269`).
- `tagMatchNotesQuery` — `deletedAt IS NULL` filtered by a JSON-contains match on
  the note's `tags` column, ordered by `coalesce(editedAt, updatedAt)` descending
  (`note-list-view.desktop.ts:60-68`).
- `deletedNotesDescQuery` — `deletedAt IS NOT NULL`, ordered by `deletedAt`
  descending (`note-store.ts:293-298`).

### Two consequences worth carrying into V2

1. **Daily notes are excluded from the default list.** The unfiltered All Notes view
   filters `isDaily = 0`, so daily notes never appear there. The **tag** and **trash**
   queries build on `undeletedNotesQuery` / the raw table instead, so a daily note
   *can* surface in those views if it carries a matching tag or has been deleted.
2. **Free-text queries do not filter the list.** Any query string that does not start
   with `#` falls through to the unfiltered `regularNotesEditedDescQuery`. The list
   view filters by **tag and trash only** — arbitrary full-text search is the separate
   `Cmd/Ctrl+K` search modal, not this surface. The `<h2>` header simply echoes the
   raw `query` (or `"Notes"` when empty) and is *not* an editable search box
   (`notes-list.tsx:59-61`).

## Data Loading and Virtualization

The list renders with `react-virtuoso` at a fixed row height of 48px
(`notes-list.tsx:84-99`). Its `data` is `listView.notes.placeholders` — an array of
lazy **model placeholders**, not hydrated note models.

- `listView.notes` is `noteStore.adapter.query(this.notesQuery)`
  (`note-list-view.desktop.ts:83-86`), which returns a `ModelAdapterQuery` exposing
  `resultIds`, `count`, and `placeholders`.
- Each placeholder wraps a note ID. Only when a placeholder's `value` is **observed**
  during render does it hydrate the real `Note` model into the in-memory pool. In the
  `itemContent` renderer, the placeholder is read inside a MobX `<Observer>`, so the
  row re-renders once the model resolves (`notes-list.tsx:93-97`).

This is what lets the view list very large graphs without loading every note: SQLite
returns the matching IDs cheaply, and only the ~screenful of visible rows get
hydrated. The tradeoff (called out in the V1 overview) is added complexity around
placeholder resolution, scroll restoration, and keeping derived row fields current.

Scroll position is tracked on the model via `scrollIndex` / `scrollIndexCounter`
(`note-list-view.desktop.ts:22-23`). When the view has focus, an effect scrolls the
target index into view — smoothly for small jumps, instantly for jumps over 20 rows
(`notes-list.tsx:22-32`). Selecting a note also scrolls it into view
(`note-list-view.desktop.ts:149-155`, `:261`).

## Row Rendering (Columns)

Each row is a `NotesListItem` (`client/screens/main/notes-list/notes-list-item.tsx`).
The fixed header row labels four columns (`notes-list.tsx:73-81`):

| Column      | Source field          | Notes                                                                 |
| ----------- | --------------------- | --------------------------------------------------------------------- |
| **Subject** | `note.title`          | Unaliased subject, or `"Untitled"`; truncated (`note.ts:412-415`)     |
| **Snippet** | `note.snippet`        | First content line, truncated to 70 chars (`note.ts:508-511`)         |
| **Tags**    | `note.tags`           | Rendered as `#a, #b` (`notes-list-item.tsx:78-80`)                     |
| **Updated** | `note.editedAtFormatted` | Relative date using the user's date/time prefs (`note.ts:535-540`) |

A circular selection indicator sits in a 48px gutter on the left, revealed on hover
and filled when the row is selected (`notes-list-item.tsx:36-59`). Selected rows get an
indigo background and border (`notes-list-item.tsx:26-34`).

## Selection and Keyboard Navigation

Selection is fully modeled on `NoteListView`, which tracks three pieces of state as
note references (`note-list-view.desktop.ts:16-20`):

- `selectedNoteRefs` — the current selection set.
- `lastSelectedNoteRef` — the most recently selected row (the cursor for arrow nav).
- `lastSelectedNotSpanNoteRef` — the anchor for shift-range selection; it stays put
  while a span grows or shrinks (`note-list-view.desktop.ts:175-182`).

### Mouse

- **Click a row** → `selectOperation` with `toggle = metaKey`, `span = shiftKey`
  (`notes-list-item.tsx:18-24`). Plain click selects exclusively; ⌘/Ctrl-click
  toggles one row; Shift-click selects a contiguous range from the anchor
  (`note-list-view.desktop.ts:210-254`).
- **Click the indicator gutter** → `checkOperation`: toggle, or Shift to range-select
  (`notes-list-item.tsx:36-45`, `note-list-view.desktop.ts:228-234`).
- **Click the subject / double-click a row** → open the note in the editor
  (`notes-list-item.tsx:25`, `:62`; `note-list-view.desktop.ts:198-200`).

### Keyboard

Hotkeys are active only while the list screen has focus (`notes-list.tsx:34-53`):

| Keys                       | Action                                                    |
| -------------------------- | --------------------------------------------------------- |
| `↑` / `↓`                  | Move selection up/down one row (exclusive)                |
| `Shift+↑` / `Shift+↓`      | Extend the range selection up/down                        |
| `Enter` / `Cmd+Enter`      | Open the first selected note in the editor                |

Arrow navigation is `selectDirection`, which resolves the next placeholder and either
selects it exclusively or extends the span (`note-list-view.desktop.ts:316-335`).
`Enter` maps to `editSelected`, which opens the first note in the selection
(`note-list-view.desktop.ts:202-208`).

Range selection (`selectSpan`) must resolve the placeholders inside the range to real
models before it can build the selection (`note-list-view.desktop.ts:290-314`); a
`TODO` there notes the intent to store IDs rather than `Ref<Note>`s to avoid that.

## Toolbar

The header's right side holds three controls (`notes-list.tsx:64-68`):

### New Note button

`NewNoteButton` calls `mainView.createAndEditNote()`
(`new-note-button.tsx:18`), which creates a note and opens it in the editor. The note
is added to the adapter immediately and force-saved
(`note-store.ts:542-565`). The shown shortcut adapts to platform — `⌘N` on Electron,
`⌃⌘N` on Apple web, `⌃⌥N` elsewhere (`new-note-button.tsx:22-24`).

### Tags toggle (filter buttons)

`TagsToggle` is a button group of fixed filters plus a custom-tag dropdown
(`client/screens/main/notes-list/tags/tags-toggle.tsx`):

- **All** → `setQuery('')` (`tags-toggle.tsx:34-40`)
- **Books** → `#book`, **Links** → `#link`, **People** → `#person`
  (`tags-toggle.tsx:42-61`). These three are the "filterable" system tags
  (`tags/types.ts`, constants in `client/models/tag/constants.ts`).
- **Trash** → `#trash` (`tags-toggle.tsx:63-68`)
- **Custom ▾** → opens a dropdown of all other tags (`tags-toggle.tsx:70-84`)

The **Custom** dropdown (`tags/tags-list-dropdown.tsx`) lists every graph tag except
the three system tags, sorted alphabetically (`tags-list-dropdown.tsx:19-21`), with a
"No custom tags" empty state (`tags-list-dropdown.tsx:42-44`). Each entry is a
`TagListItem` showing the tag name and a live count of notes carrying it
(`tags/tag-list-item-view.ts:21-33`). Clicking it sets the query to `#<tag>`
(`tag-list-item-view.ts:46-48`); an inline ✕ deletes the tag from the graph after a
confirm step (`tag-list-item-view.ts:40-53`, `tags/confirm-tag-delete.tsx`).

### Action menu (bulk operations)

`ActionMenu` renders only when at least one note is selected
(`action-menu/action-menu.tsx:11-15`). Its button shows the selection count —
`Selected (N)` — and opens a single-item menu (`action-menu.tsx:26`, `:40-56`):

- In a normal view, the item reads **"Trash selected notes"** and soft-deletes them.
- In the Trash view, it reads **"Delete selected notes"** and permanently destroys them.

The label flips on `selectedNotesAreTrashed`, i.e. whether every selected note is
already deleted (`note-list-view.desktop.ts:100-103`, `action-menu.tsx:51-54`).

## Delete, Trash, and Restore

`deleteSelectedNotes` branches on the current query (`note-list-view.desktop.ts:184-196`):

- **Outside Trash** → `noteStore.deleteNotes(selected)`: a **soft delete** that stamps
  `deletedAt` on each note and unpublishes any public links, then syncs up
  (`note-store.ts:523-532`). The notes leave All Notes and appear under Trash.
- **Inside Trash** (`query === '#trash'`) → after a `confirm('Destroy selected notes
  forever?')`, `noteStore.destroyNotes(selected)` **permanently deletes** them via
  `syncUp.deleteMany` (`note-list-view.desktop.ts:189-192`, `note-store.ts:538-540`).

Note a V1 gap: the Trash view's only bulk action is permanent destruction. There is no
**restore** affordance in this UI — recovering a trashed note would require clearing
its `deletedAt` through another path. V2 should add an explicit restore action.

## Empty States and Counts

- The header `<h2>` shows the raw query or `"Notes"`; it does not show a note count
  (`notes-list.tsx:57-62`).
- There is no dedicated empty-state component. When the query yields zero placeholders,
  the virtualizer simply renders blank space below the column header.
- A live count *does* exist per tag in the custom-tag dropdown
  (`tag-list-item-view.ts:31-33`), but not for the list as a whole.

## Key Files

| Concern                         | File                                                                 |
| ------------------------------- | ------------------------------------------------------------------- |
| List screen + virtualization    | `client/screens/main/notes-list/notes-list.tsx`                     |
| Row rendering                   | `client/screens/main/notes-list/notes-list-item.tsx`                |
| Client-only dynamic import      | `client/screens/main/notes-list/notes-list-dynamic.tsx`             |
| New-note button                 | `client/screens/main/notes-list/new-note-button.tsx`                |
| Bulk action menu                | `client/screens/main/notes-list/action-menu/action-menu.tsx`        |
| Tag filter toolbar + dropdown   | `client/screens/main/notes-list/tags/`                              |
| List/selection/query model      | `client/models/note/note-list-view.desktop.ts`                      |
| Query builders + delete/destroy | `client/models/note/note-store.ts`                                  |
| Derived row fields (title/snippet/date) | `client/models/note/note.ts`                                |
| Route serialization             | `client/core/router-view.ts`                                        |
| List navigation methods         | `client/models/main/main-view.ts`                                   |
| System tag constants            | `client/models/tag/constants.ts`                                    |

## Notes for V2

- The list filters by **tag and trash only**; treat free-text search as a separate
  surface. If V2 wants a searchable library, design the query model to actually apply
  text queries rather than silently dropping them.
- The **daily-note exclusion** in the default view is deliberate — All Notes is the
  index of *regular* notes. Decide explicitly whether V2's library includes dailies.
- The placeholder/model-pool indirection exists to virtualize large graphs against a
  local index. V2's projection should expose the same "IDs cheap, hydrate on demand"
  shape so the list scales without loading every note.
- Add a real **restore from trash** action; V1 only supports permanent destruction
  from the Trash view.
