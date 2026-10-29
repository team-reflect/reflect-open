# Plan 07 — Backlinks

**Goal:** Make `[[Wiki Links]]` the organizing primitive: fast autocomplete,
create-from-unresolved, ambient incoming backlinks, and rename that rewrites links and
keeps the old title as an alias.

**Depends on:** Plans 03 (parsing/resolution), 04 (links/backlinks/aliases tables), 05
(editor `[[` hook), 06 (date links).
**Unlocks:** richer AI context (Plan 10) and the associative recall the product is built on.

**Libraries:** ProseKit `defineAutocomplete` + shadcn/ui popover. See [Libraries](libraries.md).

## Scope

**In:** `[[` autocomplete, create-from-unresolved, incoming-backlinks panel, rename + link
rewrite + alias preservation, alias frontmatter, case-insensitive resolution.
**Out:** typed entities/people (backlinks stay plain `[[Alice]]`), graph-map view,
suggested backlinks (can follow Plan 09 retrieval).

**Carried in from Plan 06 review:** a click on an unresolved wiki link only logged to the
console. Surface it to the user (create-from-unresolved largely covers it).

## Delivery split (decided 2026-06-09)

- **07a — linking while writing** *(delivered 2026-06-09, PR #13)*, steps 1–3 + TanStack
  Query adoption:
  - Suggestions ranked in `@reflect/core` over titles + aliases + dailies (exact < prefix <
    substring, recency tie-break). A full `YYYY-MM-DD` query always offers that daily.
  - Insertion is **literal text**: wiki links are literal syntax + decorations in
    meowdown, so there is no node or serializer surface.
  - Create-from-unresolved in the popover *and* on click (decided: clicking an unresolved
    non-date link creates and opens the note; this retires the carried-in item).
  - Backlinks panel under **both regular notes and stream days** (decided), with source
    title + line snippet. Reads invalidate on the index lifecycle's post-apply hook.
- **07b — rename with automatic rewrite** (steps 4–5):
  - Includes the session-owns-frontmatter fix: meowdown mangles `---` blocks, so the
    session splits every disk read, the editor sees body only, and saves rejoin the exact
    header bytes. This makes frontmatter notes editable and gives alias writes a channel
    that never disturbs the editor.
  - Title changes on non-daily notes **auto-update** inbound links (decided, no prompt),
    triggered on *settled* titles (navigate-away / blur / quiet period), never per
    keystroke, so intermediate states never rewrite the graph.
  - Old title kept as a frontmatter alias; same-session intermediate aliases pruned.
    Daily notes are excluded (their date labels are stream chrome, not content).
  - Filenames stay put in the first wave; filename sync joins in
    [Plan 17](17-readable-filenames.md).
  - Recorded edges: a note with an explicit frontmatter `title:` cannot be renamed from
    the editor yet (`title:` is authoritative and the editor does not edit frontmatter).
    A merged write that changes the title cancels a pending rename (`#adoptMergedWrite`
    in `note-session-service.ts`).

## Steps

1. **`[[` autocomplete.** Needs the meowdown wiki-link rule from Plan 05 (meowdown has no
   `[[ ]]` support built in). Popover queries the index over titles + aliases + dailies.
   Keyboard-driven; supports `[[Note|display alias]]`.
2. **Create from unresolved.** No match → top option "Create '<name>'" (ULID + readable
   filename, Plan 02), inserts and resolves the link.
3. **Incoming backlinks (ambient).** Below the note, available while writing: source
   title + snippet, click to open. Core context (the Obsidian lesson), so keep it
   always-available and cheap.
4. **Aliases.** `aliases:` frontmatter participates in resolution + autocomplete so links
   survive renames and external edits. The V1 `//` alias-in-title convention is not
   required.
5. **Rename with rewrite.** Rewrite incoming links (minimal-diff, Plan 03) in one batched,
   undoable operation; keep the old title as an alias for links Reflect could not rewrite;
   reindex. Show progress for large rewrites; never partially apply without a checkpoint
   (ties into Plan 12).
6. **Resolution everywhere.** One resolver so editor, backlinks, search, and AI agree on
   `[[X]]`. *(First wave: collisions resolve deterministically by path order and
   autocomplete lists all candidates; the click-side picker is deferred to Plan 08.)*
7. **Tests.** Ranking, create-from-unresolved, backlinks after edits, rename rewrite +
   alias, case-insensitive + alias resolution, ambiguity.

## Key decisions / contracts

- **Adopt TanStack Query here**, because projection reads multiply (backlinks,
  autocomplete). `queryFn`s are `@reflect/core` getters, watcher `index:changed` events
  drive targeted invalidation, and markdown setters invalidate after writing (see
  [architecture-conventions](architecture-conventions.md) §5). Decided in the post-Plan-05
  refactor (June 2026) instead of retrofitting earlier screens.
- **Backlinks stay plain.** Entities can later be projections over notes + aliases.
- **Frontmatter `aliases` is the alias contract.**
- **Rename = rewrite links + keep old title as alias**, batched and recoverable.
- **One shared resolver.**

## Acceptance criteria

- `[[` autocompletes notes/dailies; Enter inserts; unresolved offers "Create".
- Backlinks render with snippets and update as links change.
- Rename rewrites referencing links; the old name still resolves via alias.

## Risks

- **Rename rewrite correctness** (code blocks, partial matches, ambiguous titles). Use
  AST-based edits, skip code contexts, and the 07b **collision guard**: when the old title
  already belongs to another note, skip both the rewrite and the alias, so existing links
  keep their target. *(Accepted edge: the guard reads the index, which lags the watcher
  debounce; a note created with the old title in that sub-second window can be missed.
  The late-created note wins future resolutions.)*
- **Autocomplete latency.** Indexed prefix query + in-memory recent-notes cache.
- **External renames** (Finder/Obsidian) arrive as delete+create; links may dangle until
  reindex and must resolve gracefully.
