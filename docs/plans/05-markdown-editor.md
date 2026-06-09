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

This supersedes the earlier CodeMirror-6 recommendation. (The two callouts to verify
remain: round-trip fidelity vs Plan 03, and meowdown's early maturity — see Risks.)

> **License flag:** `@meowdown/core` and `@meowdown/react` are **GPL-3.0-only**. Bundling
> them makes the distributed app a combined work subject to GPL-3.0, which conflicts with
> the "MIT open-source core" principle. This must be resolved (relicense Reflect core,
> obtain a more permissive grant from the author, or isolate the component). Tracked in
> [Plan 15](15-hardening-packaging-release.md) and flagged for a product decision.

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
| paragraph, heading, blockquote, list, code block (highlight TBD), table, horizontal rule | **`[[wiki links]]`** node/mark + Lezer rule + converter (→ Plan 07 autocomplete) |
| marks: strong, em, code, strikethrough, link | **images** — Lezer parses `Image`, but there is no PM `image` node yet |
| `MarkMode` live-preview + clean clipboard copy | **task checkboxes** — Lezer parses `Task`/`TaskMarker`, no interactive PM node yet |

Gaps are met by writing local ProseKit/Lezer extensions and, where it makes sense,
upstreaming to meowdown (same author as ProseKit). Wiki-links are the priority because
they are Reflect's organizing primitive.

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

6. **Wiki-link extension (foundation for Plan 07).** Add `[[ ]]` to the editor: a
   `@lezer/markdown` inline rule + a ProseMirror node/mark + `md↔pm` converter support so
   `[[Note]]` and `[[Note|alias]]` parse, render as link chips, and serialize back
   verbatim. Resolution uses Plan 03's shared resolver. The `[[` autocomplete UI is
   Plan 07; this step gives it a real node to attach to.

7. **Images & assets.** Add a PM `image` node + converter (meowdown's Lezer already emits
   `Image`). Paste/drop an image → write to `assets/` (Plan 02) → insert a relative
   markdown link → render inline. Large-file guardrail hook for Plan 12.

8. **Task checkboxes.** Add an interactive checkbox node mapped to `- [ ]`/`- [x]` (Lezer
   emits `Task`/`TaskMarker`) that toggles the underlying markdown. (Tasks-as-a-feature
   stay deferred; this is just faithful editor rendering.)

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
- **GPL-3.0 dependency is an open licensing decision** (Plan 15).

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

- **Round-trip normalization** in `docToMarkdown` (e.g. list bullet style, emphasis
  markers, table whitespace) producing noisy diffs for sync (Plan 12). Mitigate: gate
  with Plan 03's round-trip corpus against `docToMarkdown`; for programmatic edits to
  *closed* notes, prefer Plan 03 splice edits over re-serializing.
- **meowdown maturity (v0.2.0, empty README, missing nodes).** Pin the version; vendor a
  patch path; budget time to write/ upstream wiki-link, image, and checkbox extensions;
  track ProseKit `0.x` breaking changes.
- **GPL-3.0 licensing** vs MIT core — highest-level risk; resolve before public release
  (Plan 15). 
- **Uncontrolled-component ergonomics** (stale content on navigation). Mitigate with the
  single imperative `setContent` path + per-day `key` in the stream.
- **Autosave vs watcher feedback loops.** Mitigate by tagging app-originated writes.
