# Porting editor keyboard shortcuts

**Status: planned (incremental).** This doc catalogs the keyboard behaviors
of the v1 editor (`@team-reflect/reflect-editor`, Remirror/ProseMirror-based)
against what v2 already has, and calls out which gaps are worth porting.
Editor-level bindings belong upstream in meowdown; note-to-note navigation
belongs in the app.

Where v2 already binds something, the v2 combo wins — this is about porting
**behaviors**, not v1's exact keystrokes.

## Already covered in v2

No action needed; listed so nobody re-ports them. meowdown's bindings live
in `packages/core/src/extensions/key-bindings.ts` (meowdown repo); app-scope
bindings in `apps/desktop/src/lib/commands/app-commands.ts`.

| Behavior                          | v1                    | v2                                   |
| --------------------------------- | --------------------- | ------------------------------------ |
| Bold / italic / inline code       | `mod+b/i/\``          | `mod+b/i/e`                          |
| Strikethrough / highlight         | `mod+shift+x/h`       | Same                                 |
| Headings                          | `mod+alt+1…6`         | `mod+1…6`                            |
| Insert/edit link on selection     | `mod+k`               | Same                                 |
| Indent / outdent list item        | `Tab` / `shift+Tab`   | Same (prosekit list keymap)          |
| Collapse/expand a bullet          | `mod+alt+[` / `]`     | `mod+.` (single toggle)              |
| Cycle bullet → task → done        | `mod+enter`           | `mod+enter` (`rotateSquareTask`)     |
| Markdown input rules              | `- `, `1. `, `[ ] `, ```` ``` ````, `**` … | Same family |
| Undo / redo                       | PM defaults           | PM defaults                          |

## Recommended ports

Ordered by value. The first item is the reason this doc exists.

1. **Move list item up / down — `alt+↑` / `alt+↓`.**
   v1: `flat-list-extension.ts`. The single most-missed structural edit:
   reorder a bullet (with its nested children) without cut/paste. v2 has no
   binding for it; `prosemirror-flat-list`, which meowdown's list extension
   already builds on, ships the move commands — this is keymap wiring plus
   round-trip tests, in meowdown. Should also move a plain paragraph/block
   when the cursor isn't in a list, so the shortcut behaves uniformly.

2. **Wrap selection into a wikilink — `[` with a selection.**
   v1 (`backlink-extension.ts`, `handleSquareBracketInsert`): typing `[`
   over a selected word replaces it with `[[word` — brackets left open,
   cursor at the end — so the wikilink autocomplete opens immediately with
   the selection as the query; accepting a suggestion (or typing `]]`)
   completes the link. The "intelligent" part is the guards, which make
   `[[` a safe two-tap gesture rather than a modal state:
   - selection already starts with `[[` → do nothing (never `[[[`);
   - selection starts with a single `[` → strip it, so the result is
     exactly `[[…` (a second `[` tap converges instead of stacking);
   - only fires on a non-empty text selection within one block — a bare
     `[` keystroke types a literal bracket.

   v1 also bound `mod+shift+k` to the same insert with an empty selection
   allowed (drops an open `[[` at the cursor). Port both to meowdown next
   to the existing `wikilink-trigger.ts`, preserving open-ended insertion
   (autocomplete-with-query) rather than closing the brackets around the
   selection — that is what feeds the link-first workflow.

3. **Open link/wikilink/tag under the cursor from the keyboard —
   `mod+enter` on the node.** v1 let `Enter`/`mod+enter` follow backlinks
   and tags without the mouse. v2 has click handlers (`wikilink-click.ts`,
   `tag-click.ts`, `link-click.ts`) but no keyboard path. One binding in
   meowdown that resolves "the link unit at the cursor"
   (`get-link-unit-at.ts` already exists) and emits the same event clicks
   do. Plain `Enter` stays split-block; only the modified form follows.

4. **List-type toggles — `mod+shift+7/8/9`** (ordered / bullet / task,
   Google-Docs muscle memory). v2 can only reach these via input rules or
   the task-rotate cycle. Low cost in meowdown's list extension.

5. **Edge-of-note arrow navigation.** In v1, `↑` at the very start /
   `↓` at the very end of a note moved focus to the previous/next note.
   This is **app-level**, not meowdown: in the daily stream it should walk
   across days. Needs a small editor hook ("cursor tried to leave the
   document") that the host handles — same host/editor split as everything
   else.

6. **`Escape` collapses the selection.** Tiny quality-of-life v1 behavior
   (deselect without touching the mouse); verify it doesn't fight
   meowdown's menus, which also use `Escape` to dismiss.

## Deliberately not ported

- **`mod+u` underline** — not markdown; v2 has no underline mark and
  shouldn't grow one.
- **Checklist vs. task as distinct node types** (`mod+shift+enter` cycle).
  v1 had two checkbox-flavored list kinds; markdown has one (`- [ ]`). The
  single `mod+enter` rotation covers it.
- **`mod+j` prediction menu and its result keys** (`mod+enter` replace,
  `i` insert, `r` re-run, `c` copy, `esc` stop). `mod+j` is the copilot in
  v2, and selection AI is designed in
  [ai-menu-and-prompts.md](./ai-menu-and-prompts.md) — but v1's
  single-key accept/insert/retry/copy vocabulary is good prior art for that
  doc's Accept/Discard/Retry controls.
- **Slash menu trigger** — v2 inserts via the command palette and meowdown
  insert menus; see [note-templates.md](./note-templates.md).
- **Transcription keys** — audio memos have their own v2 surface
  ([audio-memos.md](./audio-memos.md)); `esc`-to-stop is worth mirroring
  there if it isn't already.
- **PageUp/PageDown note navigation** — covered by app navigation history
  (`mod+[`/`mod+]`) and the palette; low demand.

## Conflicts to watch

- `mod+[` / `mod+]` are **back/forward** at app scope, while the prosekit
  list keymap also binds `mod+[` to outdent inside the editor. The
  ownership rule: `editor`-scope bindings win while focus is in the
  editor; `app`-scope bindings apply everywhere else; and the registry
  (`apps/desktop/src/editor/keymap.ts`) rejects duplicates only *within*
  a scope — so a chord shared across scopes is a deliberate decision, not
  an accident. New bindings go through that registry and get listed in
  the `mod+/` cheat-sheet.
- v1 resolved `alt`-combos through `keyboard-layout-map` for non-US
  layouts; `alt+↑`/`alt+↓` are layout-safe (no printable character), which
  is another reason to prefer them for list moves.

## Open questions

- Whether `alt+↑/↓` should also swap table rows when inside a table (nice,
  but tables have their own selection rules — decide in meowdown).
- Wrap-selection-on-`[` triggers on the **first** `[` in v1 (the guards
  make a second tap converge to the same `[[…` state). That means a user
  who wanted a literal `[word]` can't get it by typing over a selection;
  v1 accepted that trade. Decide whether meowdown keeps it, or reserves
  the wrap for the second tap and lets a single `[` type literally —
  stricter markdown fidelity, slightly slower linking.
