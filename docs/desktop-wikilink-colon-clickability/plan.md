# Desktop Wiki-Link Colon Clickability Plan

## Goal

Fix the desktop editor regression where wiki-links whose titles contain a colon outside a digit-colon-digit sequence render as inert text, while keeping the indexer/backlinks behavior unchanged.

## Current Findings

- The Reflect indexer and shared markdown scanner use `packages/core/src/markdown/grammar.ts`, whose `WikiLink` extension accepts any non-empty single-line `[[...]]` body.
- Desktop editing is delegated to `@meowdown/react`/`@meowdown/core` through `apps/desktop/src/editor/note-editor.tsx`; Reflect passes `onWikiLinkClick` through to Meowdown and handles target resolution in `apps/desktop/src/editor/use-wiki-link-navigation.ts`.
- The iOS/mobile route in Reflect also uses `NoteEditor`, but the report says the iOS app path works; compare any mobile-specific rendering/touch behavior before changing Reflect grammar.
- Recent relevant history includes repeated Meowdown dependency bumps, ending with `fix: update meowdown to ^0.50.0 (#798)`.

## Plan

1. Reproduce the parser/decorator mismatch in an isolated test by exercising the editor-facing wiki-link recognition path, not only the core index scanner.
2. Inspect Meowdown's published grammar/decorator/click code and compare it to Reflect's shared `wikiLinkExtension` and mobile/touch path.
3. Choose the narrowest canonical fix:
   - Prefer a shared parser/decorator utility if Reflect owns it.
   - If Meowdown owns the broken parser and there is no local Meowdown checkout, patch Reflect's dependency/version path only if a released upstream fix exists; otherwise add a focused Reflect-side compatibility adapter only after documenting why the canonical upstream layer is unavailable in this worktree.
4. Add regression coverage for rendering/decorations and target extraction/click navigation:
   - Supplied A/B matrix links.
   - Boundary cases: `letter:digit`, `digit:letter`, trailing colon, leading colon, multiple colons, digit:digit, aliases, long titles, parentheses/ampersands, Unicode punctuation.
   - Non-regression syntax: protocols/URLs, Markdown links, tags, time/verse text, code spans/fences, empty/unclosed/multiline wiki-link candidates, and selections where relevant.
5. Confirm indexing/backlinks remain unchanged by running the existing focused core markdown/indexing tests and adding assertions only if they document the invariant.
6. Run focused Vitest suites for the touched editor/core paths, `pnpm check`, and any reasonably scoped package build or desktop test.
7. Attempt a desktop interaction pass. If the local app cannot run, document the exact limitation in `final-report.md`.
8. Update `status.md` throughout, then complete `final-report.md` with root cause, regression matrix, verification, and residual risk.
9. Commit, push, open a ready PR against `master`, and check for immediate CI/PR blockers.
