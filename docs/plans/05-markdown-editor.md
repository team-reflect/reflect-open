# Plan 05 — Markdown Editor (meowdown)

**Goal:** The core surface — a calm, fast, WYSIWYG-feel markdown editor where the buffer
round-trips to clean markdown, rendered beautifully in place, fully keyboard-native. The
editor is **[meowdown](https://github.com/prosekit/meowdown)** (`@meowdown/react` +
`@meowdown/core`), a ProseKit/ProseMirror editor over `@lezer/markdown`.

**Depends on:** Plan 02 (read/write), Plan 03 (parse/serialize/resolution).
**Unlocks:** Plan 06 (daily-note editing), 07 (backlink autocomplete), 10 (AI edits
applied here).

## Scope

**In:** integrating meowdown, live-preview via `MarkMode`, the save pipeline, keyboard
ergonomics, note-switch + external-reload via imperative content, image/asset handling,
and the extensions Reflect must add (wiki-links, images, task checkboxes).
**Out:** backlink autocomplete UI (Plan 07 builds on the wiki-link node added here), AI
patch application UI (Plan 10), split-pane (deferred; leave seams).

## Decision: use meowdown (committed)

The editor is chosen: **meowdown**, the ProseKit-based markdown WYSIWYG editor. Why it
fits Reflect's "markdown is the source of truth" constraint better than a typical
ProseMirror rich editor:

- It parses markdown with **`@lezer/markdown`** (GFM) and **retains the syntax characters
  in the document** as text spans carrying an `mdMark` mark, with semantic marks
  (`mdStrong`, `mdEm`, `mdCode`, `mdDel`, `mdLinkText`, `mdLinkUri`) overlaid.
- A **`MarkMode`** plugin (`'hide' | 'focus' | 'show'`) decorates those syntax chars:
  hidden, revealed near the caret (`focus` — the Obsidian-style live-preview feel), or
  always shown. Default **`focus`**.
- Because syntax is never discarded, `docToMarkdown(doc)` is **near-lossless** — which
  resolves the round-trip concern that would otherwise push us to a source-buffer editor.

This supersedes the earlier CodeMirror-6 recommendation. Round-trip fidelity is now
verified by the Plan 01 spike; the remaining watch-item is meowdown's early maturity
(see Risks).

> **License:** meowdown is **first-party** (owned by the team) and MIT-licensed, so it fits
> the MIT-core principle with no copyleft constraint. (Earlier drafts flagged GPL-3.0; that
> is resolved.)

## meowdown API surface (what we build against)

```tsx
import { Editor } from '@meowdown/react'           // React component
import {
  markdownToDoc, docToMarkdown,                    // md <-> ProseMirror doc
  defineEditorExtension, defineMarkMode,            // imperative/extension API
  type TypedEditor, type MarkMode,
} from '@meowdown/core'
import { createEditor } from '@prosekit/core'

// Declarative (uncontrolled): initialContent is read ONCE on first render.
<Editor
  markMode="focus"
  initialContent={markdownText}
  onChange={({ getMarkdown }) => save(getMarkdown())}
/>
```

Key consequence: `<Editor>` is **uncontrolled** — changing `initialContent` later is
ignored. To show a different note (Plan 06 navigation) or reload after an external change,
either **remount** with `key={notePath}` or drive the instance imperatively
(`editor.setContent(markdownToDoc(editor, md))`). Reflect standardizes on one of these
(see step 3).

## Coverage vs gaps

| Provided by meowdown today | Reflect must add (this plan / Plan 07) |
|---|---|
| paragraph, heading, blockquote, list, code block (highlight TBD), table, horizontal rule | **`[[wiki links]]`** view decorations + the shared Lezer scanner (→ Plan 07 autocomplete) |
| marks: strong, em, code, strikethrough, link | **images** — Lezer parses `Image`, but there is no PM `image` node yet |
| `MarkMode` live-preview + clean clipboard copy | **task checkboxes** — Lezer parses `Task`/`TaskMarker`, no interactive PM node yet |

Gaps are met by writing local ProseKit/Lezer extensions and, where it makes sense,
upstreaming to meowdown (same author as ProseKit). Wiki-links are the priority because
they are Reflect's organizing primitive.

## Delivery split (decided 2026-06-09)

- **05a** — steps 1–6 plus the keymap registry seed from step 9: the composed editor
  (meowdown + Reflect extensions), wiki-link chips, the save pipeline + external-change
  reconciliation (`useNoteDocument`), DS-token styling, and the workspace bound to a real
  persistent note (`notes/welcome.md`, created on first open) until Plan 06 brings
  navigation.
- **05b** — step 7 (images/assets, incl. a Rust binary asset-write command), heading
  toggles from step 9, a **round-trip safety guard** (see below), and the step 10
  basics. **Task checkboxes (step 8) were blocked upstream** — meowdown's converter
  *lost task-item text entirely* (`+ [ ] todo` → empty list), discovered while
  building 05b. **The blocker is cleared:** meowdown 0.3.0 round-trips task lists
  byte-faithfully (verified 2026-06-12) and models them as `list` nodes with
  `kind: "task"` + `checked`. Interactive checkboxes now land with
  [Plan 18 (Tasks)](18-tasks.md) step 1. The round-trip safety guard stays regardless:
  any note the editor can't faithfully round-trip opens **protected (read-only)** and
  is never auto-rewritten, so a converter gap can degrade UX but can never destroy
  content. Remaining for later: ergonomics (indent/outdent, move line, zen),
  and deeper perf/a11y.

## Steps

1. **Add deps + wrap.** Install `@meowdown/react`, `@meowdown/core`, and their ProseKit/
   Lezer peers. Build `NoteEditor` (`src/components/editor/`) wrapping meowdown's
   `<Editor>`. A `useNoteDocument` hook owns document state: current path, last-saved
   markdown, dirty flag, and external-change reconciliation.

2. **Live preview + tokens.** Default `markMode="focus"`. Import meowdown's `style.css`
   and theme the `.md-mark`, `.md-link-uri`, heading/list/code/table styles with the
   design-system tokens so it matches the app (calm, indigo accent, Inter).

3. **Note switching + reload (uncontrolled-component contract).** Standardize on
   **imperative content** for fidelity: hold one `createEditor()` instance per visible
   pane; on navigate/reload call `editor.setContent(markdownToDoc(editor, md))`. (For the
   daily stream's mounted-per-day editors, remount-by-`key={date}` is the simpler path —
   Plan 06.) Never change a note by mutating `initialContent`; it is ignored by design.

4. **Save pipeline.** `onChange` → debounced `getMarkdown()` → atomic write (Plan 02) →
   reindex that file (Plan 04). Maintain a dirty indicator; flush on blur/quit. Tag
   app-originated writes so the watcher (Plan 04) ignores our own saves (avoid feedback
   loops).

5. **External-change reconciliation.** When the watcher reports the open file changed and
   the buffer is clean → `editor.setContent(markdownToDoc(...))`. If dirty → present a
   non-destructive choice (keep mine / load theirs / review), reusing the conflict
   vocabulary Plan 12 formalizes. Never silently clobber unsaved edits.

6. **Wiki-link extension (foundation for Plan 07).** Add `[[ ]]` to the editor so
   `[[Note]]` and `[[Note|alias]]` render as link chips and serialize back verbatim.
   **Mechanism (revised 2026-06-09, implemented in 05a): view *decorations* over the
   literal text, not a PM node/mark.** Reading meowdown's inline pass settled this: it
   recomputes each block's marks from its own Lezer parse on every text change and
   *strips any mark not in its computed set*, so a custom mark would be removed (or
   fight the engine with ping-ponging appendTransactions). Decorations never touch the
   document — serialization is byte-identical by construction. Detection reuses the
   canonical grammar via `scanInlineWikiLinks` (`@reflect/core`), and the syntax spans
   follow meowdown's own MarkMode reveal contract (`.show` near the caret). If Plan 07
   needs a real inline node, the path is upstreaming `WikiLink` into meowdown itself
   (first-party), not fighting it from outside. Resolution uses Plan 03's shared
   resolver; the `[[` autocomplete UI is Plan 07.

7. **Images & assets.** Add a PM `image` node + converter (meowdown's Lezer already emits
   `Image`). Paste/drop an image → write to `assets/` (Plan 02) → insert a relative
   markdown link → render inline. Large-file guardrail hook for Plan 12.

8. **Task checkboxes.** Add an interactive checkbox node mapped to `+ [ ]`/`+ [x]`
   tasks (Lezer emits `Task`/`TaskMarker`) that toggles the underlying markdown.
   Square `- [ ]` checklist checkboxes may render through the same editor affordance
   but do not aggregate into Tasks. (This step now ships as
   [Plan 18 (Tasks)](18-tasks.md) step 1, where tasks-as-a-feature land too.)

9. **Keyboard ergonomics (product identity).** meowdown ships base keymap/commands/
   history. Layer Reflect shortcuts (bold/italic, toggle heading, toggle checkbox, indent/
   outdent, move line, zen mode) into a **central keymap registry** so Plan 06
   (navigation), 07 (`[[`), 08 (`⌘K`), and 10 (AI sidebar) share one source of truth and
   never collide.

10. **Performance + a11y.** Smooth typing on large notes; correct focus management;
    reduced-motion respected; DS-token contrast in light/dark.

## Key decisions / contracts

- **meowdown is the editor; markdown round-trips via `docToMarkdown`.** Fidelity holds
  because syntax is retained in-doc.
- **`<Editor>` is uncontrolled** — note switching/reload use imperative `setContent` (or
  remount-by-key), never prop changes.
- **Reflect owns three editor extensions:** wiki-links, images, task checkboxes.
- **One central keymap registry** owns all shortcuts app-wide.
- **The editor writes files + fires reindex; it never blocks on the index.**
- **Libraries:** meowdown (`@meowdown/react`/`core`) + ProseKit + `@lezer/markdown`,
  first-party MIT (installed in Plan 01). See [Libraries](libraries.md).

## Acceptance criteria

- Open a note: markdown renders with `focus` live-preview (syntax revealed near caret);
  typing is smooth.
- Headings, lists, quotes, code, tables, links, images, checkboxes edit and **save
  byte-faithfully** — `docToMarkdown` output round-trips through Plan 03's corpus.
- `[[Note]]` / `[[Note|alias]]` render as chips and serialize verbatim.
- Switching notes / external reload uses imperative `setContent`; dirty buffers prompt,
  never clobber.
- Keymap registry has no duplicate bindings (test).
- `pnpm typecheck` + tests pass.

## Risks

- **Round-trip normalization** in `docToMarkdown` — **confirmed** by the Plan 01 spike:
  inline content (incl. wiki-links) is byte-identical, but lists serialize "loose" (a blank
  line between items). Mitigate: add a tight-list serializer option or normalize-on-import,
  and gate with the round-trip corpus; for edits to *closed* notes, prefer Plan 03 splice
  edits over re-serializing.
- **meowdown maturity (v0.2.0, empty README, missing nodes).** We own the editor (first-
  party) so we can extend/upstream directly, but it's pre-1.0: pin versions, budget time
  for the wiki-link/image/checkbox extensions, and track ProseKit `0.x` churn.
- **Uncontrolled-component ergonomics** (stale content on navigation). Mitigate with the
  single imperative `setContent` path + per-day `key` in the stream.
- **Autosave vs watcher feedback loops.** Mitigate by tagging app-originated writes.
