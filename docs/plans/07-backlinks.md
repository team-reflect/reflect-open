# Plan 07 — Backlinks

**Goal:** Make `[[Wiki Links]]` the organizing primitive: fast autocomplete,
create-from-unresolved, ambient incoming backlinks while writing, and rename that
rewrites links + preserves the old title as an alias.

**Depends on:** Plan 03 (link parsing/resolution), Plan 04 (links/backlinks/aliases
tables), Plan 05 (editor `[[` hook), Plan 06 (date links).
**Unlocks:** richer AI context (Plan 10), and the associative recall the product is built
on.

## Scope

**In:** `[[` autocomplete, create-note-from-unresolved-link, incoming-backlinks panel,
rename + link rewrite + alias preservation, alias frontmatter, case-insensitive
resolution.
**Out:** typed entities/people/companies (deferred — backlinks stay plain `[[Alice]]`),
graph-map view (deferred), suggested backlinks (nice-to-have; can follow once retrieval
exists in Plan 09).

## Steps

1. **`[[` autocomplete.** Builds on the meowdown wiki-link extension added in Plan 05
   (step 6) — meowdown has no `[[ ]]` support out of the box, so that node/Lezer rule is a
   prerequisite. Wire a ProseKit autocomplete/predict trigger on `[[` to a popover that
   queries the index (Plan 04) over titles + aliases (and `YYYY-MM-DD` dailies), ranked by
   recency/match. Keyboard-driven: type to filter, ↑/↓ to move, Enter to insert, Esc to
   dismiss. Supports `[[Note|display alias]]` syntax.

2. **Create from unresolved.** If the typed target has no match, the top option is
   "Create '<name>'" → makes a new note (Plan 02 ULID + readable filename), inserts the
   link, resolves it. Following an unresolved `[[link]]` already in text offers the same.

3. **Incoming backlinks (ambient).** Below the note (and available while writing, not only
   in search), render incoming backlinks from the `backlinks` table (Plan 04): source
   note title + the surrounding line/snippet, click to open. This is core context, per
   the Obsidian lesson — keep it always-available and cheap.

4. **Aliases.** Support `aliases:` in frontmatter (Plan 03 schema). Aliases participate in
   resolution + autocomplete so links survive renames and external edits. The `//`-style
   V1 alias-in-title convention is *not* required; frontmatter aliases are the contract.

5. **Rename with rewrite.** Renaming a note (title and/or file):
   - rewrites known incoming `[[links]]` across the graph to the new title (minimal-diff
     edits via Plan 03), in a single batched, undoable operation;
   - preserves the previous title as an alias so any links Reflect couldn't rewrite (or
     external ones) still resolve;
   - updates the file path (Plan 02 `note_move` → OS-aware) and reindexes affected notes.
   Show progress for large rewrites; never partially-apply without recording a checkpoint
   (ties into Plan 12 checkpoints once available).

6. **Resolution everywhere.** Centralize link resolution (Plan 03 rules) so the editor,
   backlinks panel, search, and AI context all agree on what `[[X]]` points to.
   Case-insensitive title/alias match; ambiguous matches surface a disambiguation choice.

7. **Tests.** Autocomplete ranking; create-from-unresolved; backlink rows after edits;
   rename rewrites N referencing notes and adds the alias; case-insensitive + alias
   resolution; ambiguity handling.

## Key decisions / contracts

- **Backlinks stay plain.** No typed-entity layer in first wave; entities can later be
  projections over notes + aliases.
- **Frontmatter `aliases` is the alias contract** (not title `//`).
- **Rename = rewrite links + keep old title as alias**, batched and recoverable.
- **One shared resolver** used by editor, backlinks, search, and AI.

## Acceptance criteria

- Typing `[[` autocompletes existing notes/dailies; Enter inserts; unresolved offers
  "Create".
- Incoming backlinks render under a note with snippets and update as links change.
- Renaming a note rewrites referencing links and the old name still resolves via alias.
- Case-insensitive + alias resolution covered by tests.
- `pnpm typecheck` + tests pass.

## Risks

- **Rename rewrite correctness** (links in code blocks, partial matches, ambiguous
  titles). Mitigate: AST-based edits only (Plan 03), skip code contexts, require
  disambiguation for collisions, batch + checkpoint.
- **Autocomplete latency** on large graphs. Mitigate with an indexed prefix query +
  in-memory recent-notes cache.
- **External renames** (file moved in Finder/Obsidian). The watcher (Plan 04) must treat
  it as delete+create and reconcile by `id`; links may dangle until reindex — resolve
  gracefully.
