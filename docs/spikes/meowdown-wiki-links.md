# Spike — meowdown `[[wiki link]]` go/no-go (Plan 01 §8)

**Question:** Can `[[wiki links]]` — Reflect's core organizing primitive, which
[meowdown](https://github.com/prosekit/meowdown) has no built-in support for — be added to
the meowdown editor cleanly enough to commit to it for Plans 05–10? If not, the editor
decision changes now (fallback: CodeMirror-6 live-preview).

**Verdict: GO (technical gate passed).** Fidelity is free, the extension path is clear,
and an autocomplete primitive exists. The remaining work (chip rendering + `[[`
autocomplete UI) is normal Plan 05/07 effort, not a feasibility risk. Two caveats to carry:
the **GPL-3.0 licensing** question (unresolved, Plans 00/15) and a **loose-list
normalization** in the serializer.

What's verified here is headless (build, types, round-trip). The subjective "does it feel
good" check needs the GUI — run `pnpm tauri dev` (or `pnpm --filter @reflect/desktop dev`
in a browser) to try the editor mounted in `app.tsx`.

## Method

- Installed `@meowdown/react` `@meowdown/core` + `@prosekit/*` + `@lezer/*` into
  `apps/desktop` (v0.2.0 / prosekit 0.12–0.17 / lezer 1.x).
- Read meowdown's parser + inline-mark machinery from source.
- Wrote a round-trip test: `apps/desktop/src/editor/markdown-roundtrip.test.ts`.
- Mounted the real editor in the app (`apps/desktop/src/editor/note-editor.tsx`,
  rendered by `app.tsx`) with a sample note containing `[[wiki links]]`.

## Findings

1. **Fidelity is free.** meowdown keeps the *literal markdown syntax as document text*
   (`[[Foo]]`, `**bold**` stay as characters) and layers rendering **marks** on top via an
   `appendTransaction` plugin (`inlineTextToMarkChunks`). So `markdownToDoc → docToMarkdown`
   preserves `[[Wiki Link]]`, `[[Note|alias]]`, and `[[2026-06-09]]` **byte-identical**
   (the only delta is a single trailing newline the serializer appends). A wiki-link is
   therefore just *another inline mark over literal text* — no custom node, no fidelity risk.
   *Tested* (8 cases, green).

2. **Loose-list normalization (caveat).** `docToMarkdown` serializes lists "loose" — it
   inserts a blank line between items (`- a\n\n- b`). Not content loss, but it would create
   spurious sync diffs (Plan 12) against tight-list input. **Action (Plan 05):** add a
   tight-list serializer option or a normalize-on-import pass before relying on byte-stable
   round-trips. (Captured as a test so it can't regress silently.)

3. **Extending meowdown = compose at the ProseKit layer.** `@meowdown/react`'s `<Editor>`
   does **not** accept extra extensions, and `inlineTextToMarkChunks` isn't exported. So we
   add wiki-links by building our own editor component (template: meowdown's `editor.tsx`)
   that does `union(defineEditorExtension(), defineWikiLink())`, where `defineWikiLink`
   contributes (a) an `mdWikiLink` mark spec rendered as a chip and (b) a small
   `appendTransaction` plugin that marks `[[…]]` runs (skipping code spans). Alternatively,
   upstream wiki-link support to meowdown (same author as ProseKit). Either is tractable.

4. **Autocomplete primitive exists, but is low-level.** `defineAutocomplete`
   (`@prosekit/extensions/autocomplete`) fires `onEnter({ state, match, from, to,
   deleteMatch, ignoreMatch })` when a regex (e.g. `/\[\[([^\[\]]*)$/`) matches before the
   cursor. It gives positions; **we build the popover UI + insertion** (index-backed
   suggestions in Plan 07/08). So `[[` autocomplete is real UI work, not a freebie — budget
   it in Plan 07.

5. **It builds and runs.** The editor compiles, typechecks, and bundles
   (509 modules; ~207 kB gz — ProseMirror weight, code-split later). Mounted in the app for
   manual evaluation.

## Risks / caveats to carry forward

- **GPL-3.0** (`@meowdown/*`) vs the MIT-core goal — unresolved product decision
  (Plans 00, 05, 15). This spike treats the dependency as **provisional**.
- **Maturity:** v0.2.0, empty README, no extra-extension API → we own a custom editor
  component (and likely upstream PRs). Pin versions; watch ProseKit `0.x` churn.
- **Bundle size** from ProseMirror/ProseKit; revisit with code-splitting.
- **Subjective feel** (chip rendering, `[[` autocomplete, caret behavior in `MarkMode`
  focus) is **not** verified headlessly — confirm via `tauri dev`.

## Recommended next actions

- Proceed with meowdown for Plans 05–07 (GO), pending the GPL decision.
- Plan 05: custom editor component (`union` + `defineWikiLink`), tight-list serializer,
  images + task-checkbox extensions.
- Plan 07: `[[` autocomplete UI on `defineAutocomplete`, backed by the index.
- Keep CodeMirror-6 live-preview as the documented fallback if the GUI feel disappoints or
  GPL blocks distribution.
