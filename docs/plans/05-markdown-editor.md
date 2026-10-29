# Plan 05 — Markdown Editor (meowdown)

**Goal:** The core surface: a calm, fast, WYSIWYG-feel Markdown editor whose buffer
round-trips to clean Markdown, rendered in place, fully keyboard-native. The editor is
**[meowdown](https://github.com/prosekit/meowdown)**, a ProseKit/ProseMirror editor over
`@lezer/markdown`.

**Depends on:** Plan 02 (read/write), Plan 03 (parse/serialize/resolution).
**Unlocks:** Plan 06 (daily editing), 07 (backlink autocomplete), 10 (AI edits).

## Scope

**In:** meowdown integration, live preview via `MarkMode`, the save pipeline, keyboard
ergonomics, note switch + external reload, images/assets, and the extensions Reflect
adds (wiki-links, images, task checkboxes).
**Out:** backlink autocomplete UI (Plan 07), AI patch UI (Plan 10), split-pane
(deferred; leave seams).

## Decision: use meowdown (committed)

meowdown fits "Markdown is the source of truth" better than a typical ProseMirror rich
editor:

- It parses with `@lezer/markdown` (GFM) and **keeps the syntax characters in the
  document** as text spans with an `mdMark` mark, with semantic marks overlaid.
- `MarkMode` (`'hide' | 'focus' | 'show'`) decorates the syntax chars. Default
  **`focus`** reveals them near the caret (Obsidian-style live preview).
- Because syntax is never discarded, `docToMarkdown` is **near-lossless**, which removes
  the round-trip concern that would otherwise push us to a source-buffer editor.

This supersedes the earlier CodeMirror-6 recommendation. The Plan 01 spike verified
round-trip fidelity; meowdown's early maturity is the remaining watch-item.

> **License:** meowdown is **first-party** and MIT, so it fits the MIT-core principle.
> (Earlier drafts flagged GPL-3.0; that is resolved.)

## The uncontrolled-editor contract

meowdown's `<Editor>` reads `initialContent` **once**; later changes are ignored. To show
a different note or reload after an external change, either remount with `key` or call
`editor.setContent(markdownToDoc(editor, md))`. Reflect standardizes on one (step 3).

## Coverage vs gaps

| Provided by meowdown | Reflect must add |
|---|---|
| paragraph, heading, blockquote, list, code block, table, horizontal rule | **`[[wiki links]]`** decorations + shared Lezer scanner (Plan 07 autocomplete) |
| marks: strong, em, code, strikethrough, link | **images**: Lezer parses `Image`, no PM node yet |
| `MarkMode` live preview + clean clipboard copy | **task checkboxes**: Lezer parses `Task`, no interactive node yet |

Gaps are met with local ProseKit/Lezer extensions, upstreamed to meowdown where it makes
sense (same author as ProseKit). Wiki-links come first: they are Reflect's organizing
primitive.

## Delivery split (decided 2026-06-09)

- **05a:** steps 1–6 plus the keymap registry seed (step 9): composed editor, wiki-link
  chips, save pipeline + external-change reconciliation, DS-token styling, and the
  workspace bound to a real note (`notes/welcome.md`, created on first open) until Plan
  06 brings navigation.
- **05b:** step 7 (images/assets, incl. a Rust binary asset-write command), heading
  toggles, a **round-trip safety guard**, and step 10 basics. **Task checkboxes (step
  8) were blocked upstream:** meowdown's converter lost task-item text (`+ [ ] todo` →
  empty list). **Cleared:** meowdown 0.3.0 round-trips task lists byte-faithfully
  (verified 2026-06-12), modeling them as `list` nodes with `kind: "task"` + `checked`;
  interactive checkboxes land with [Plan 18 (Tasks)](18-tasks.md) step 1. The safety
  guard stays regardless: a note the editor cannot faithfully round-trip opens
  **protected (read-only)** and is never auto-rewritten, so a converter gap can degrade
  UX but never destroy content. Later: indent/outdent, move line, zen, deeper perf/a11y.

## Steps

1. **Wrap meowdown** in a `NoteEditor`; a document hook owns current path, last-saved
   Markdown, dirty flag, and external-change reconciliation.
2. **Live preview + tokens:** `focus` mode, meowdown styles themed with DS tokens.
3. **Note switching + reload:** standardize on **imperative `setContent`** with one
   editor instance per visible pane. The daily stream's per-day editors remount by
   `key={date}` (Plan 06). Never change a note by mutating `initialContent`.
4. **Save pipeline:** debounced `getMarkdown()` → atomic write (Plan 02) → reindex that
   file (Plan 04). Dirty indicator; flush on blur/quit. Tag app-originated writes so the
   watcher ignores our own saves (no feedback loops).
5. **External-change reconciliation:** clean buffer → reload. Dirty → non-destructive
   choice (keep mine / load theirs / review), reusing Plan 12's conflict vocabulary.
   Never silently clobber unsaved edits.
6. **Wiki-links** (`[[Note]]`, `[[Note|alias]]`) render as chips and serialize
   verbatim. **Mechanism (revised 2026-06-09): view decorations over the literal text,
   not a PM node/mark.** meowdown recomputes each block's marks from its own Lezer parse
   on every change and strips any mark outside its computed set, so a custom mark would
   be removed or ping-pong with appendTransactions. Decorations never touch the
   document, so serialization is byte-identical by construction. Detection reuses the
   canonical grammar from `@reflect/core`; syntax spans follow meowdown's MarkMode
   reveal contract. If Plan 07 needs a real inline node, upstream `WikiLink` into
   meowdown (first-party) rather than fight it from outside.
7. **Images & assets:** PM `image` node. Paste/drop writes to `assets/`, inserts a
   relative Markdown link, renders inline. Large-file guardrail hook for Plan 12.
8. **Task checkboxes:** interactive checkbox for `+ [ ]`/`+ [x]` tasks that toggles the
   underlying Markdown. Square `- [ ]` checklists may share the affordance but do not
   aggregate into Tasks. (Now ships as [Plan 18](18-tasks.md) step 1.)
9. **Keyboard ergonomics (product identity):** Reflect shortcuts go into a **central
   keymap registry** so Plans 06, 07 (`[[`), 08 (`⌘K`), and 10 share one source of
   truth and never collide.
10. **Performance + a11y:** smooth typing on large notes, focus management,
    reduced motion, DS-token contrast in light/dark.

## Key decisions / contracts

- **meowdown is the editor; Markdown round-trips via `docToMarkdown`** because syntax
  is retained in-doc.
- **`<Editor>` is uncontrolled:** switching/reload use `setContent` or remount-by-key,
  never prop changes.
- **Reflect owns three editor extensions:** wiki-links, images, task checkboxes.
- **One central keymap registry** owns all shortcuts.
- **The editor writes files + fires reindex; it never blocks on the index.**
- **Libraries:** meowdown + ProseKit + `@lezer/markdown`, first-party MIT. See
  [Libraries](libraries.md).

## Acceptance criteria

- A note renders with `focus` live preview; typing is smooth.
- Headings, lists, quotes, code, tables, links, images, checkboxes **save
  byte-faithfully** through Plan 03's round-trip corpus.
- Wiki-links render as chips and serialize verbatim.
- Switching notes / external reload never clobber a dirty buffer.
- Keymap registry has no duplicate bindings (test).

## Risks

- **Round-trip normalization, confirmed by the Plan 01 spike:** inline content (incl.
  wiki-links) is byte-identical, but lists serialize "loose" (blank line between
  items). Mitigate with a tight-list option or normalize-on-import, gated by the
  corpus; for edits to *closed* notes, prefer Plan 03 splice edits over re-serializing.
- **meowdown maturity (pre-1.0, missing nodes).** We own it, so we can extend/upstream,
  but pin versions, budget time for the extensions, and track ProseKit `0.x` churn.
- **Uncontrolled-editor ergonomics** (stale content on navigation): the single
  `setContent` path + per-day `key`.
- **Autosave vs watcher feedback loops:** tag app-originated writes.
