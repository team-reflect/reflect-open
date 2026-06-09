# Plan 08 — Lexical Search & Command Palette

**Goal:** The `⌘K` surface: fast local full-text + title search, structured filters,
navigation commands, and command execution — the primary recall + navigation entry point.

**Depends on:** Plan 04 (FTS + projections), Plan 06 (routes/date navigation).
**Unlocks:** results usable as AI context (Plan 10), CLI search (Plan 14), and the
command registry that deep links/CLI reuse later.

**Libraries:** `cmdk` (⌘K palette) + shadcn/ui; FTS via `rusqlite` (Plan 04). See
[Libraries](libraries.md).

## Scope

**In:** `⌘K` palette, FTS over titles/body, title/fuzzy match, backlink-aware filters,
date/tag/pinned-style filters, navigation commands (today, relative dates, open note),
command execution, keyboard-only operation, result preview/open.
**Out:** semantic/vector search (Plan 09 — same surface, additive), AI chat over results
(Plan 10).

## Steps

1. **Command palette shell** (`src/components/command-palette/`): a `⌘K` modal
   (shadcn `command` / cmdk) that is keyboard-native — open, type, arrow, Enter, Esc.
   Single surface for **find + navigate + do**, matching V1's three jobs for search.

2. **Lexical search.** Query FTS5 (Plan 04) over title + body; rank by relevance with a
   title boost. Add fuzzy title matching for jump-to-note. Return snippets with match
   highlights; Enter opens (navigates via Plan 06 route model), preview on focus.

3. **Filters.** Structured filters expressed as UI chips → query constraints: tag,
   created/updated date ranges, daily-notes-only, links-to/linked-from a note
   (backlink-aware via Plan 04). Keep the filter set small and composable for first wave.

4. **Navigation + commands via a typed command registry.** Define a `Command` contract
   (id, title, args schema, keybinding, run) and register: go to today, go to date /
   "N days from now", new note, open random note, toggle theme, open settings, rebuild
   index, etc. The palette lists and runs commands; the **same registry is the future
   integration point for deep links and the CLI** (don't build three command systems).

   ```ts
   // src/lib/commands/command.ts
   export interface Command<Args = void> {
     id: string
     title: string
     keybinding?: string
     run: (args: Args) => void | Promise<void>
   }
   ```

5. **Result model.** Unify notes, daily dates, and commands into one ranked result list
   with clear sections, so one keystroke flow covers everything. Recent/most-relevant
   first when the query is empty.

6. **Performance.** Sub-50ms typical query on a large graph via FTS + small result caps +
   debounced input. Index-backed, never a file scan.

7. **Tests.** FTS ranking + title boost; filter → constraint translation; command
   registry execution; keyboard-only flow (open → filter → Enter opens correct route).

## Key decisions / contracts

- **One `⌘K` surface** for find/navigate/do.
- **A single typed command registry** powers the palette now and deep links/CLI later.
- **Search is index-backed**, never a filesystem scan.

## Acceptance criteria

- `⌘K` opens instantly; typing returns ranked note + command results with highlights.
- Filters (tag, date, daily-only, linked-from) narrow results correctly.
- "Go to today", "N days from now", "new note", "random note" work from the palette.
- Entire flow is operable without the mouse.
- `pnpm typecheck` + tests pass.

## Risks

- **Doing too much in one box** (find + navigate + command) hurting clarity. Mitigate
  with clear result sectioning + ranking, validated by keyboard-flow tests.
- **FTS tokenization** for code/identifiers/CJK. Pick a tokenizer (e.g. `unicode61`/
  `trigram`) deliberately; revisit if recall is poor.
- **Filter combinatorics** bloating the query builder. Keep the first-wave filter set
  intentionally small.
