# Desktop Wiki-Link Colon Clickability Final Report

## Root Cause

Reflect's indexer was not the failing layer. The shared Reflect parser in `packages/core/src/markdown/grammar.ts` already treats any non-empty single-line `[[...]]` as a wiki link, including colons, aliases, parentheses, ampersands, and Unicode punctuation.

The inert desktop behavior was in the editor rendering/tokenization dependency path. Reflect delegates the primary editor and Markdown preview/snippet rendering to Meowdown; with `@meowdown/core`/`@meowdown/react` `0.50.0`, colon-bearing wiki-link source could fail to become an editor `mdWikilink` chip in the desktop beta path. The current `master` base already contains `@meowdown/core`/`@meowdown/react` `0.61.0`, whose tokenizer restores `mdWikilink` rendering/click payloads for colon-bearing targets.

## Change

- Rebuilt the PR on `origin/master`, preserving its existing `@meowdown/core` and `@meowdown/react` `^0.61.0` dependency state without package or lockfile churn.
- Added desktop rendering/click regression coverage in `BacklinkSnippet`, which uses Meowdown's rendered wiki-link chip path.
- Added Reflect navigation coverage proving `Test: Colon Link` reaches `resolveOrCreateNoteWithTitle` unchanged.
- Added core scanner coverage proving indexing/backlink parsing continues to accept colon-bearing wiki links.

## Regression Matrix

Covered supplied cases and A/B controls:

- `[[Test: Colon Link]]`
- `[[Test Colon Link]]`
- `[[Test:Colon NoSpace Link]]`
- `[[Test 1:19 Digit Colon]]`
- `[[Test: Colon And Parens (2026-07-28)]]`
- `[[Test Long With Parens & Ampersand Follow-up (2026-07-28 1208) - Suffix Segment]]`
- `[[Meeting: VendorA x CompanyB AI Marketplace (2026-07-27)]]`
- `[[Meeting: AI Widget Builder Pricing Strategy & Partner Deal Follow-up (2026-07-28 1208) - CompanyB Forecast Meeting]]`

Covered boundaries:

- letter:digit, digit:letter, leading colon, trailing colon, multiple colons, digit:digit, alias with colon, long title, parentheses/ampersands, Unicode punctuation.
- Markdown links, bare URLs, tags, time text, code spans, and fenced code remain non-wiki-link syntax unless explicitly wrapped in `[[...]]`.

## Verification

- `pnpm exec vitest run --config ../../vitest.config.ts --project browser src/components/backlink-snippet.test.tsx src/editor/use-wiki-link-navigation.test.tsx`
- `pnpm exec vitest run --config /tmp/reflect-core-vitest.config.mjs src/markdown/scan.test.ts src/markdown/grammar.test.ts src/markdown/extract.test.ts`
- `pnpm check`
- `pnpm --filter @reflect/desktop build`
- Started the Vite desktop dev server on `http://localhost:1420/` and confirmed `curl -I` returned `200 OK`; stopped the server afterward.

## Limitations

- A full Tauri GUI click pass was not possible from this shell: there is no available browser/Tauri automation hook for the native desktop app.
- A malformed initial focused-test command accidentally ran the full desktop Vitest suite and hit an unrelated existing `localStorage` failure in `src/lib/semantic.test.ts`; the intended focused suites pass.
