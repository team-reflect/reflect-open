# Reflect V1: "All Notes" Behavior

The **All Notes** view in Reflect V1, as a reference for the V2 rewrite. All file paths refer to
the **V1 codebase** (`~/repos/reflect`, a Next.js + MobX-Keystone app), not this repository.
For broader context, see [Reflect V1 Overview](./reflect-v1-overview.md).

## What It Is

A virtualized, table-style list with one row per note: subject, snippet, tags, last-edited
date. It is both:

- **Library**: the browseable index of every regular note.
- **Filtered result view**: a tag click anywhere opens All Notes scoped to that tag, and
  **Trash** is the same component with a different query.

It is one of the main screens (`MainScreen.NoteList`), with Daily, Tasks, Map, and Search.

## Routing and Entry Points

`client/core/router-view.ts` serializes app state to URLs: `/g/:graphId/list` or
`/g/:graphId/list/:query`. The route carries `noteListQuery`, and applying a route calls
`listView.setQuery` (`router-view.ts:60`, `:105-107`).

In `client/models/main/main-view.ts`: `openListScreen()` clears the filter (`:280`),
`setAndOpenSearchQuery(query)` sets one (`:567`), and `openNotesListForTag(tag)` calls it with
`'#' + tag` (`:572`). Every tag click routes there.

The component loads client-side only (`notes-list-dynamic.tsx`, a Next.js dynamic import),
because it needs the browser-only virtualizer and the SQLite-backed model pool.

## The Query Model

One `query` string on `NoteListView` (`client/models/note/note-list-view.desktop.ts:21`) drives
the list. Setting the **same** query again does not re-filter; it scrolls to the top
(`:125-132`), so the toolbar buttons double as "scroll to top."

The `notesQuery` getter (`:70-81`) maps the query to one of three `NoteStore` queries
(`client/models/note/note-store.ts`):

| `query` value        | Resolves to                          | Meaning                                  |
| -------------------- | ------------------------------------ | ---------------------------------------- |
| `'#trash'`           | `deletedNotesDescQuery`              | Deleted notes, newest-deleted first      |
| starts with `'#'`    | `tagMatchNotesQuery`                 | Undeleted notes carrying that tag        |
| anything else (incl. `''`) | `regularNotesEditedDescQuery` | All regular (non-daily) undeleted notes  |

The default and tag queries order by `coalesce(editedAt, updatedAt)` descending. The tag query
uses a JSON-contains match on the `tags` column. Trash orders by `deletedAt`.

### Two consequences worth carrying into V2

1. **Daily notes are excluded from the default list** (`isDaily = 0`). The tag and trash
   queries do not apply that filter, so a tagged or deleted daily note *can* appear there.
2. **Free-text queries do not filter the list.** A query without `#` falls through to the
   unfiltered list. Full-text search is the separate `Cmd/Ctrl+K` modal. The `<h2>` header
   just echoes the raw query (or `"Notes"`), and is not an editable search box.

## Data Loading and Virtualization

The list uses `react-virtuoso` with 48px rows (`notes-list.tsx:84-99`). Its data is
`listView.notes.placeholders`: lazy **model placeholders**, not hydrated notes.
`noteStore.adapter.query(...)` returns a `ModelAdapterQuery` with `resultIds`, `count`, and
`placeholders`. A placeholder hydrates its `Note` into the in-memory pool only when its `value`
is observed during render, inside a MobX `<Observer>`, so the row re-renders when the model
resolves.

So SQLite returns matching IDs cheaply, and only the visible rows hydrate, which lets very large
graphs list fast. The cost is complexity around placeholder resolution, scroll restoration, and
keeping derived row fields current.

`scrollIndex` / `scrollIndexCounter` track scroll position. With focus, an effect scrolls the
target into view: smoothly for small jumps, instantly for jumps over 20 rows
(`notes-list.tsx:22-32`). Selecting a note also scrolls to it.

## Row Rendering (Columns)

Each row is a `NotesListItem` (`notes-list-item.tsx`):

| Column      | Source field          | Notes                                                                 |
| ----------- | --------------------- | --------------------------------------------------------------------- |
| **Subject** | `note.title`          | Unaliased subject, or `"Untitled"`; truncated (`note.ts:412-415`)     |
| **Snippet** | `note.snippet`        | First content line, truncated to 70 chars (`note.ts:508-511`)         |
| **Tags**    | `note.tags`           | Rendered as `#a, #b`                                                  |
| **Updated** | `note.editedAtFormatted` | Relative date using the user's date/time prefs (`note.ts:535-540`) |

A circular selection indicator in a 48px left gutter shows on hover and fills when selected.
Selected rows get an indigo background and border.

## Selection and Keyboard Navigation

`NoteListView` models selection as note references (`note-list-view.desktop.ts:16-20`):
`selectedNoteRefs` (the set), `lastSelectedNoteRef` (the arrow-nav cursor), and
`lastSelectedNotSpanNoteRef` (the shift-range anchor, fixed while a span grows or shrinks).

### Mouse

- **Click a row**: plain click selects exclusively, ⌘/Ctrl-click toggles, Shift-click selects a
  range from the anchor (`note-list-view.desktop.ts:210-254`).
- **Click the gutter**: toggle, or Shift for a range.
- **Click the subject, or double-click a row**: open the note.

### Keyboard

Active only while the list has focus (`notes-list.tsx:34-53`):

| Keys                       | Action                                                    |
| -------------------------- | --------------------------------------------------------- |
| `↑` / `↓`                  | Move selection up/down one row (exclusive)                |
| `Shift+↑` / `Shift+↓`      | Extend the range selection up/down                        |
| `Enter` / `Cmd+Enter`      | Open the first selected note in the editor                |

Range selection (`selectSpan`, `:290-314`) must resolve the placeholders in the range to real
models first. A `TODO` there wants to store IDs instead of `Ref<Note>`s to avoid that.

## Toolbar

### New Note button

`NewNoteButton` calls `mainView.createAndEditNote()`, which adds the note to the adapter at once,
force-saves it, and opens it (`note-store.ts:542-565`). The shortcut is `⌘N` on Electron, `⌃⌘N`
on Apple web, and `⌃⌥N` elsewhere.

### Tags toggle (filter buttons)

`TagsToggle` (`notes-list/tags/tags-toggle.tsx`) holds fixed filters: **All** (`''`), **Books**
(`#book`), **Links** (`#link`), **People** (`#person`), **Trash** (`#trash`), and a **Custom ▾**
dropdown. Books, Links, and People are the "filterable" system tags
(`client/models/tag/constants.ts`).

The Custom dropdown (`tags-list-dropdown.tsx`) lists every other tag alphabetically, with a "No
custom tags" empty state. Each entry shows a live note count. Clicking sets the query to
`#<tag>`. An inline ✕ deletes the tag from the graph after a confirm step.

### Action menu (bulk operations)

`ActionMenu` shows only with a selection. Its button reads `Selected (N)` and opens one item:
**"Trash selected notes"** (soft delete) in a normal view, or **"Delete selected notes"**
(permanent) when every selected note is already deleted (`selectedNotesAreTrashed`).

## Delete, Trash, and Restore

`deleteSelectedNotes` (`note-list-view.desktop.ts:184-196`) branches on the query:

- **Outside Trash**: `noteStore.deleteNotes` stamps `deletedAt`, unpublishes public links, and
  syncs up (`note-store.ts:523-532`). The notes move to Trash.
- **Inside Trash**: after `confirm('Destroy selected notes forever?')`, `destroyNotes` deletes
  them permanently via `syncUp.deleteMany`.

V1 gap: Trash has no **restore** in this UI. Recovering a note needs clearing `deletedAt`
another way.

> **V2 decision (supersedes the original "V2 should add restore" note):** V2 deletes to the
> **OS-native trash** instead of a `deletedAt` soft delete. It ships *no* in-app Trash view and
> *no* Restore action: the OS handles both, and a restored `.md` re-indexes itself. See
> [TDR 0004](./decisions/0004-all-notes-trash-and-tag-scope.md).

## Empty States and Counts

The header shows the raw query or `"Notes"`, with no note count. There is no empty-state
component: zero results render blank space under the column header. Only the custom-tag dropdown
shows counts.

## Key Files

| Concern                         | File                                                                 |
| ------------------------------- | ------------------------------------------------------------------- |
| List screen + virtualization    | `client/screens/main/notes-list/notes-list.tsx`                     |
| Row rendering                   | `client/screens/main/notes-list/notes-list-item.tsx`                |
| New-note button                 | `client/screens/main/notes-list/new-note-button.tsx`                |
| Bulk action menu                | `client/screens/main/notes-list/action-menu/action-menu.tsx`        |
| Tag filter toolbar + dropdown   | `client/screens/main/notes-list/tags/`                              |
| List/selection/query model      | `client/models/note/note-list-view.desktop.ts`                      |
| Query builders + delete/destroy | `client/models/note/note-store.ts`                                  |
| Derived row fields (title/snippet/date) | `client/models/note/note.ts`                                |
| Route serialization             | `client/core/router-view.ts`                                        |
| List navigation methods         | `client/models/main/main-view.ts`                                   |

## Notes for V2

- The list filters by **tag and trash only**. If V2 wants a searchable library, its query model
  must apply text queries instead of silently dropping them.
- The **daily-note exclusion** is deliberate: All Notes indexes *regular* notes. Decide
  explicitly whether V2's library includes dailies.
- The placeholder/model-pool indirection virtualizes large graphs against a local index. V2's
  projection should keep the same "IDs cheap, hydrate on demand" shape.
- **Restore from trash: declined.** V2 deletes to the OS-native trash, which owns browse and
  restore ([TDR 0004](./decisions/0004-all-notes-trash-and-tag-scope.md)).
- The Custom dropdown's inline **delete-a-tag** is **not** ported: tags come from note bodies,
  so removing a tag means editing it out of the notes (same TDR).
