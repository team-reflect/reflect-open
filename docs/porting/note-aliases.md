# Porting note aliases

**Status: ported.** Frontmatter aliases shipped with the readable-filenames
work ([docs/readable-filenames.md](../readable-filenames.md)); direct support
for v1 `//` titles followed in `v0.4.0-beta.31` and stable `v0.4.0`.

## What v1 did

In v1, aliases were part of the note's title: editing the H1 to
`Superman // Clark Kent // Kal‑El` made everything after each `//` an alias.
`[[` autocomplete matched aliases, links through any spelling resolved to the
canonical note, and backlinks aggregated under the canonical title. A saved
v1 link carried the target note's stable ID as well as its visible label, so an
existing link survived a rename even when the old spelling disappeared from
the title. Its displayed label could remain stale; the ID still identified the
note.

## How v2 does it

Frontmatter is the native files-first representation for aliases:

```yaml
---
id: 01J9ZK...
aliases:
  - Clark Kent
  - Kal-El
---

# Superman
```

- The `aliases` field is a plain YAML string array
  (`packages/core/src/markdown/model.ts`); malformed values degrade to an
  empty list rather than breaking the note.
- V1 titles also work without conversion. For `# Tim MacCaw // Dad`, the
  complete H1 remains the canonical title while `Tim MacCaw` and `Dad` are
  derived into the rebuildable alias projection. The markdown file is not
  rewritten.
- `[[Dad]]` resolves to that note and counts as its backlink. Choosing the
  `Dad` autocomplete match normally writes `[[Tim MacCaw // Dad|Dad]]`, so the
  editor displays the alias the user chose. Unlike v1's ID-backed links, this
  is still a textual address: if another note wins the complete-title key, the
  alias itself is used when it uniquely resolves to the selected note. A note
  with no winning textual key is omitted from `[[` autocomplete rather than
  inserting a link to a different note.
- Read-only wiki-link resolution and backlinks are deterministic: a
  calendar-valid daily date wins, then an exact title, then an alias; collisions
  within one tier choose the first graph-relative path alphabetically. The
  `note_keys` view contains that winner plus the winning tier's claim count.
  Writable navigation refuses an ambiguous winning tier, and `[[` autocomplete
  omits the same ambiguous address (date-shaped or not) unless a unique alias
  can address the selected note. Clicking a valid ISO date whose key is
  unclaimed still opens or lazily creates that daily.
- Renames are **stronger than v1**: the rename coordinator
  (`apps/desktop/src/editor/rename-coordinator.ts`) rewrites known
  `[[old title]]` links across the graph, then records the old title as an
  alias so unindexed or external references keep resolving too.
- Because the whole `Tim MacCaw // Dad` H1 is v2's canonical title, changing
  only its `Dad` segment is still a normal title rename. It can rename the
  markdown file and rewrite graph links; `//` is compatibility syntax, not a
  separately stored alias field. Use frontmatter `aliases` when that distinction
  matters.
- Daily notes may carry frontmatter or derived `//` aliases. Their calendar
  date remains the strongest address for the ISO-date key.
- Markdown wikilinks additionally support display text via
  `[[target|shown text]]` — a per-link cosmetic that v1 didn't have, distinct
  from aliases (which affect resolution).

## v1 → v2 mapping

| v1                                               | v2                                                              |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `Title // Alias1 // Alias2` in the H1            | Supported directly; segments become derived index aliases       |
| Existing links keep working by stable target ID  | Textual links are rewritten; old title is preserved as alias    |
| No alias UI beyond the title bar                 | `//` remains available; frontmatter aliases are also editable   |
| Daily links target the note's stable identity    | Date wins its key; daily notes may also project aliases         |
| Alias collisions: first match wins, silently     | Read winner is deterministic; writable ambiguity is refused    |

## Diagnosing an alias report

1. Check the app version. Direct `//` support begins in
   `v0.4.0-beta.31` and is included in stable `v0.4.0` and later. Earlier
   builds treat the whole H1 as one literal title. Upgrading triggers the
   projection-version rebuild that adds the derived aliases to the index.
2. Check for a standalone note whose complete title is the reported alias.
   For example, an older build may have created `# Dad` when `[[Dad]]` looked
   unresolved. That exact title intentionally wins over the `Dad` alias on
   `# Tim MacCaw // Dad`, for navigation, backlinks, and autocomplete.
3. If both notes are intentional, use the canonical target explicitly — for
   example `[[Tim MacCaw // Dad|Dad]]` when that full title resolves to the
   intended note. Otherwise rename or remove the accidental standalone note so
   bare `[[Dad]]` resolves through the alias. Duplicate complete titles are
   ambiguous for writable navigation; give the intended note a unique alias —
   `[[` autocomplete then offers it through that alias even when the search
   matched its title.

## Open porting task

- **Collision surfacing.** Writable navigation reports ambiguity, but there is
  no persistent lint-style indicator showing every title or alias collision.
  Worth adding eventually, but not a porting blocker.
