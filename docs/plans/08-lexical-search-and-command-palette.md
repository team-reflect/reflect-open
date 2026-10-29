# Plan 08 — Lexical Search & Command Palette

**Goal:** The `⌘K` surface: fast local full-text + title search, filters, navigation
commands, and command execution. The primary recall + navigation entry point.

**Depends on:** Plan 04 (FTS + projections), Plan 06 (routes/date navigation).
**Unlocks:** results as AI context (Plan 10), CLI search (Plan 14), and the command
registry that deep links/CLI reuse.

**Libraries:** `cmdk` + shadcn/ui; FTS via `rusqlite` (Plan 04). See [Libraries](libraries.md).

## Scope

**In:** `⌘K` palette, FTS over titles/body, fuzzy title match, backlink-aware filters,
date/tag filters, navigation commands, command execution, keyboard-only operation.
**Out:** semantic search (Plan 09, same surface, additive), AI chat over results (Plan 10).

**Non-goals (decided 2026-06-09):** the ambiguous-`[[link]]` disambiguation picker (from
Plan 07) stays deferred; deterministic resolution holds until it gets a deliberate UX.
The global status surface is **not** Plan 08 scope; it lands first as its own pass.

## Delivery split (decided 2026-06-09)

**Pre-work, foundations pass (own PR, before 08a):** merge the two module-global
registries (quit-flush, path→session) into one `open-documents` service. Add the
app-global `operations` store + `OperationsStatus` surface (running entries with optional
progress; failures linger so backgrounded errors are not lost). Route the rename
coordinator's progress/errors through it, replacing the pane-local banner. This keeps 08a
purely about search + palette.

- **08a — palette, lexical search, command registry:**
  1. `cmdk` palette in a `⌘K` modal registered through the app-scope keymap registry.
  2. **Typed command registry** (`src/lib/commands/`). The hardcoded `⌘D/⌘N/⌘[/⌘]`
     shortcuts **migrate into registry entries**: one source of truth for deep links and
     the CLI. First wave: today, new note, go to date (ISO), random note, toggle theme,
     rebuild index.
  3. **Lexical search.** Empty palette = **recent notes only** (decided: zero-keystroke
     recall; commands appear when the query matches, `>` filters to commands). Typed
     queries: FTS5 with a **bm25 title boost** and `snippet()` **highlights** (decided: no
     preview pane in the first wave), merged with fuzzy title matches (Plan 07a's exact <
     prefix < substring ranking). Reads use TanStack Query under `['index', root, …]`, so
     Plan 07a's post-apply invalidation keeps them fresh.
  4. **`search/:query` opens the palette pre-filled** (decided), so there is no second
     search surface to keep consistent.
  5. **One ranked list with sections** (Notes / Dailies / Commands). Debounced input,
     small caps, index-only.
- **08b — filters** *(delivered 2026-06-09)*: filter tokens parsed from the query
  (`#tag`, `is:daily`, `links:Note` / `links:"Multi Word"`, `linked-from:Note`,
  `updated:>YYYY-MM-DD`, `<`, or bare for that day, local time against `mtime`) become
  composable predicates over the notes projection. An unresolvable link target matches
  nothing instead of ignoring the filter. Without free text, results order by recency.
  A malformed token stays search text, so typing never hides results behind a half-formed
  filter. Chips UI can follow later.

**`updated:` semantics (accepted 2026-06-09):** it compares file `mtime`, which Reflect's
own writes also touch (a rename rewrite updates every edited source file). So `updated:D`
can include notes the *system* wrote that day. The durable fix is content-authored
timestamps, when an editing-history feature needs them.

**Tokenizer:** `search_fts` uses the default `unicode61`. If recall on code
identifiers/CJK is poor, switching (e.g. to `trigram`) needs an FTS-rebuilding migration:
cheap, since the index is rebuildable, but still a migration.

## Steps

1. **Palette shell** (`src/components/command-palette/`): one keyboard-native surface for
   **find + navigate + do**, matching V1's three jobs for search.
2. **Lexical search.** FTS5 over title + body with a title boost, plus fuzzy title match.
   Snippets with highlights; Enter navigates via the Plan 06 route model.
3. **Filters.** Tag, date ranges, daily-only, links-to/linked-from. Small and composable.
4. **Typed command registry** (id, title, args, keybinding, run). The **same registry is
   the future integration point for deep links and the CLI**: do not build three command
   systems.

   ```ts
   export interface Command<Args = void> {
     id: string
     title: string
     keybinding?: string
     run: (args: Args) => void | Promise<void>
   }
   ```

5. **Result model.** Notes, dailies, and commands in one sectioned list.
6. **Performance.** Sub-50ms typical query on a large graph. Index-backed, never a file scan.
7. **Tests.** Ranking + title boost, filter → constraint translation, command execution,
   keyboard-only flow.

## Key decisions / contracts

- **One `⌘K` surface** for find/navigate/do.
- **A single typed command registry** for the palette now and deep links/CLI later.
- **Search is index-backed**, never a filesystem scan.

## Acceptance criteria

- `⌘K` opens instantly; typing returns ranked note + command results with highlights.
- Filters (tag, date, daily-only, linked-from) narrow results correctly.
- "Go to today", "N days from now", "new note", "random note" work.
- The whole flow works without the mouse.

## Risks

- **Too much in one box** hurts clarity. Mitigate with sectioning + ranking.
- **FTS tokenization** for code/CJK. Revisit the tokenizer if recall is poor.
- **Filter combinatorics.** Keep the first-wave set small.
