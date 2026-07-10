# Porting note aliases

**Status: ported.** Frontmatter aliases shipped with the readable-filenames
work ([docs/readable-filenames.md](../readable-filenames.md)); direct support
for v1 `//` titles followed in `v0.4.0-beta.31` and stable `v0.4.0`.

## What v1 did

In v1, aliases were part of the note's title: editing the H1 to
`Superman // Clark Kent // Kal‑El` made everything after each `//` an alias.
`[[` autocomplete matched aliases, links through any spelling resolved to the
canonical note, and backlinks aggregated under the canonical title. Renaming
a note did **not** rewrite existing links — old links kept working only as
long as their spelling still appeared somewhere in the title.

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
  `Dad` autocomplete match writes `[[Tim MacCaw // Dad|Dad]]`: the canonical
  target stays unambiguous while the editor displays the alias the user chose.
- Wiki-link resolution is deterministic: a calendar-valid daily date wins,
  then an exact title, then an alias; collisions within one tier choose the
  first graph-relative path alphabetically. The `note_keys` and `backlinks`
  views apply the same policy as navigation.
- Renames are **stronger than v1**: the rename coordinator
  (`apps/desktop/src/editor/rename-coordinator.ts`) rewrites known
  `[[old title]]` links across the graph, then records the old title as an
  alias so unindexed or external references keep resolving too.
- Markdown wikilinks additionally support display text via
  `[[target|shown text]]` — a per-link cosmetic that v1 didn't have, distinct
  from aliases (which affect resolution).

## v1 → v2 mapping

| v1                                               | v2                                                              |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `Title // Alias1 // Alias2` in the H1            | Supported directly; segments become derived index aliases       |
| Rename keeps old links only via title spelling   | Rename rewrites links **and** preserves title as alias          |
| No alias UI beyond the title bar                 | `//` remains available; frontmatter aliases are also editable   |
| Daily notes cannot be renamed or aliased         | Same: daily notes are keyed by date                             |
| Alias collisions: first match wins, silently     | Daily, then title, then alias; path breaks ties deterministically |

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
   example `[[Tim MacCaw // Dad|Dad]]`. Otherwise rename or remove the
   accidental standalone note so bare `[[Dad]]` resolves through the alias.

## Open porting task

- **Collision surfacing.** Neither v1 nor v2 warns when two notes claim the
  same alias. Worth a lint-style indicator eventually, but not a porting
  blocker.
