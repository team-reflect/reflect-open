# Plan 07 — Backlinks

**Goal:** Make `[[Wiki Links]]` the organizing primitive: fast autocomplete,
create-from-unresolved, ambient incoming backlinks while writing, and rename that
rewrites links + preserves the old title as an alias.

**Depends on:** Plan 03 (link parsing/resolution), Plan 04 (links/backlinks/aliases
tables), Plan 05 (editor `[[` hook), Plan 06 (date links).
**Unlocks:** richer AI context (Plan 10), and the associative recall the product is built
on.

**Libraries:** ProseKit `defineAutocomplete` (the `[[` trigger, installed) + shadcn/ui
popover for the suggestion menu. See [Libraries](libraries.md).

## Scope

**In:** `[[` autocomplete, create-note-from-unresolved-link, incoming-backlinks panel,
rename + link rewrite + alias preservation, alias frontmatter, case-insensitive
resolution.
**Out:** typed entities/people/companies (deferred — backlinks stay plain `[[Alice]]`),
graph-map view (deferred), suggested backlinks (nice-to-have; can follow once retrieval
exists in Plan 09).

**Carried in from Plan 06 review:** clicking a wiki link that fails to resolve currently
logs to the console only — surface it to the user (toast/inline) as part of this plan's
link UX (create-from-unresolved largely subsumes the failure case).

## Delivery split (decided 2026-06-09)

- **07a — linking while writing** *(delivered 2026-06-09, PR #13)* (steps 1–3 + the TanStack Query adoption):
  `[[` autocomplete (ProseKit autocomplete popover; suggestions ranked in
  `@reflect/core` over titles + aliases + dailies, exact < prefix < substring,
  recency tie-break; a full `YYYY-MM-DD` query always offers that daily — files
  are created lazily); insertion is **literal text** (wiki links are literal
  syntax + decorations in the meowdown model — no node, no serializer surface);
  create-from-unresolved in the popover *and* on click (decided: clicking an
  unresolved non-date `[[link]]` creates the note and opens it immediately —
  this also retires the carried-in failure-feedback item); the incoming-
  backlinks panel under **both regular notes and stream days** (decided), with
  source title + line snippet, reads via TanStack Query invalidated by the
  index lifecycle's post-apply hook (initial reconcile + each watcher batch).
- **07b — rename with automatic rewrite** (steps 4–5; includes the
  session-owns-frontmatter editor fix — meowdown mangles `---` blocks, so the
  session splits every disk read, the editor sees body only, and saves rejoin
  the exact header bytes; this is what makes frontmatter notes editable and
  gives alias writes a channel that never disturbs the editor view): title changes on
  non-daily notes **auto-update** inbound `[[links]]` (decided — no
  confirmation prompt), triggered on *settled* titles (navigate-away / blur /
  quiet period), never per keystroke — intermediate typing states must not
  rewrite the graph; old title preserved as a frontmatter alias, same-session
  intermediate aliases pruned; daily notes excluded (their date labels are
  stream chrome, not content). Filenames stay put in the first wave — the
  title lives in content, and `note_move` filename-sync can join later.
  Two recorded edges: a note with an explicit frontmatter `title:` cannot be
  renamed from the editor yet (the heading isn't its title — `title:` is
  authoritative and the editor doesn't edit frontmatter; a title field editor
  is a later surface), and a rename pending while a conflict is parked stays
  pending until the conflict resolves ("keep mine" re-arms it, "load theirs"
  cancels it) — rewriting the graph for a title the user may discard would
  strand every rewritten link.

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
   *(First wave: collisions resolve deterministically — same note every time, by path
   order — and the autocomplete lists all candidates; the click-side disambiguation
   picker is deferred to Plan 08, whose command-palette UI makes it nearly free.)*

7. **Tests.** Autocomplete ranking; create-from-unresolved; backlink rows after edits;
   rename rewrites N referencing notes and adds the alias; case-insensitive + alias
   resolution; ambiguity handling.

## Key decisions / contracts

- **Adopt TanStack Query here.** This plan is where projection reads multiply
  (backlinks panel, `[[` autocomplete), so it's the agreed point to introduce
  `@tanstack/react-query` per [architecture-conventions §5](architecture-conventions.md):
  `queryFn`s are `@reflect/core` getters (`getBacklinks`, `searchNotes`), the
  watcher's `index:changed` events drive targeted `queryClient.invalidateQueries`,
  and markdown setters invalidate after writing. Decided during the post-Plan-05
  refactor (June 2026) rather than retrofitting earlier file-only screens.
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
