# Porting editor keyboard shortcuts

**Status: planned (incremental).** This doc compares the keyboard behaviors
of the v1 editor (`@team-reflect/reflect-editor`, Remirror/ProseMirror)
with v2 and names the gaps worth porting. Editor bindings belong upstream
in meowdown; note-to-note navigation belongs in the app. Where v2 already
binds something, the v2 combo wins: this ports **behaviors**, not v1's
keystrokes.

## Already covered in v2

Listed so nobody re-ports them. meowdown bindings live in
`packages/core/src/extensions/key-bindings.ts` (meowdown repo); app-scope
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

Ordered by value.

1. **Move list item up / down: `alt+↑` / `alt+↓`.** v1:
   `flat-list-extension.ts`. The most-missed structural edit: reorder a
   bullet with its children without cut/paste. `prosemirror-flat-list`
   (under meowdown's list extension) already ships the commands, so this is
   keymap wiring plus round-trip tests in meowdown. It should also move a
   plain block outside a list, so the shortcut behaves uniformly.

2. **Wrap selection into a wikilink: `[` with a selection.** v1
   (`backlink-extension.ts`, `handleSquareBracketInsert`): typing `[` over a
   selected word replaces it with `[[word`, brackets left open and cursor at
   the end, so autocomplete opens with the selection as the query. The
   guards make `[[` a safe two-tap gesture:
   - selection already starts with `[[` → do nothing (never `[[[`);
   - selection starts with one `[` → strip it, so the result is `[[…`;
   - only a non-empty text selection within one block triggers it; a bare
     `[` types a literal bracket.

   v1 also bound `mod+shift+k` to the same insert with an empty selection
   allowed. Port both to meowdown next to `wikilink-trigger.ts`, keeping
   open-ended insertion (autocomplete-with-query) rather than closing the
   brackets: that feeds the link-first workflow.

3. **Open the link/wikilink/tag under the cursor: `mod+enter` on the
   node.** v1 followed backlinks and tags from the keyboard. v2 has click
   handlers (`wikilink-click.ts`, `tag-click.ts`, `link-click.ts`) but no
   keyboard path. One meowdown binding that resolves the link unit at the
   cursor (`get-link-unit-at.ts`) and emits the click event. Plain `Enter`
   still splits the block.

4. **List-type toggles: `mod+shift+7/8/9`** (ordered / bullet / task,
   Google-Docs habit). Low cost in meowdown's list extension.

5. **Edge-of-note arrow navigation.** In v1, `↑` at the start / `↓` at the
   end moved to the previous/next note. This is **app-level**: in the daily
   stream it walks across days. It needs a small editor hook ("cursor tried
   to leave the document") for the host.

6. **`Escape` collapses the selection.** Verify it doesn't fight meowdown's
   menus, which also use `Escape`.

## Deliberately not ported

- **`mod+u` underline**: not markdown; v2 has no underline mark.
- **Checklist vs. task as distinct node types** (`mod+shift+enter`):
  markdown has one checkbox kind; the `mod+enter` rotation covers it.
- **`mod+j` prediction menu and its result keys** (`mod+enter` replace, `i`
  insert, `r` re-run, `c` copy, `esc` stop). `mod+j` is the copilot in v2
  and selection AI is in [ai-menu-and-prompts.md](./ai-menu-and-prompts.md),
  but v1's single-key vocabulary is good prior art for its
  Accept/Discard/Retry controls.
- **Slash menu trigger**: see [note-templates.md](./note-templates.md).
- **Transcription keys**: audio memos have their own surface
  ([audio-memos.md](./audio-memos.md)); mirror `esc`-to-stop there if
  missing.
- **PageUp/PageDown note navigation**: covered by history (`mod+[`/`mod+]`)
  and the palette.

## Conflicts to watch

- `mod+[` / `mod+]` are back/forward at app scope, while the prosekit list
  keymap binds `mod+[` to outdent; the editor wins when focused. New
  bindings must go through `apps/desktop/src/editor/keymap.ts` (which
  rejects duplicates) and appear in the `mod+/` cheat-sheet.
- v1 resolved `alt` combos through `keyboard-layout-map` for non-US
  layouts. `alt+↑`/`alt+↓` produce no printable character, so they are
  layout-safe, another reason to use them for list moves.

## Open questions

- Should `alt+↑/↓` swap table rows inside a table? Tables have their own
  selection rules; decide in meowdown.
- v1 wraps on the **first** `[`, so a user cannot type a literal `[word]`
  over a selection; v1 accepted that. Decide whether meowdown keeps it or
  wraps only on the second tap (stricter markdown fidelity, slower
  linking).
