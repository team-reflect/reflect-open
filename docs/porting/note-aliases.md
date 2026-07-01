# Porting note aliases

**Status: ported.** Aliases shipped with the readable-filenames work
([docs/readable-filenames.md](../readable-filenames.md)); this doc records
how the v1 concept maps onto what v2 does, and the one open porting task
(import).

## What v1 did

In v1, aliases were part of the note's title: editing the H1 to
`Superman // Clark Kent // Kal‑El` made everything after each `//` an alias.
`[[` autocomplete matched aliases, links through any spelling resolved to the
canonical note, and backlinks aggregated under the canonical title. Renaming
a note did **not** rewrite existing links — old links kept working only as
long as their spelling still appeared somewhere in the title.

## How v2 does it

The concept survives intact; the mechanism moves out of the title and into
frontmatter, where it belongs in a files-first app:

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
- `[[` autocomplete matches titles, aliases, and daily dates alike through
  the `note_keys` view in the SQLite index
  (`crates/index-schema/migrations/0001_initial.sql`); link resolution
  checks the same keys with an explicit precedence — date, then title,
  then alias.
- Renames are **stronger than v1**: the rename coordinator
  (`apps/desktop/src/editor/rename-coordinator.ts`) rewrites known
  `[[old title]]` links across the graph, then records the old title as an
  alias so unindexed or external references keep resolving too.
- Markdown wikilinks additionally support display text via
  `[[target|shown text]]` — a per-link cosmetic that v1 didn't have, distinct
  from aliases (which affect resolution).

## v1 → v2 mapping

| v1                                               | v2                                                     |
| ------------------------------------------------ | ------------------------------------------------------ |
| `Title // Alias1 // Alias2` in the H1            | `aliases:` array in frontmatter                        |
| Rename keeps old links only via title spelling   | Rename rewrites links **and** preserves title as alias |
| No alias UI beyond the title bar                 | Frontmatter is directly editable (in-app or any tool)  |
| Daily notes cannot be renamed or aliased         | Same: daily notes are keyed by date                    |
| Alias collisions: first match wins, silently     | Same at resolution time (open question below)          |

## Open porting tasks

- **Import.** When importing a v1 export
  ([plans/13-import-export-portability.md](../plans/13-import-export-portability.md)),
  titles containing `//` should be split: the first segment becomes the
  title, the rest become frontmatter `aliases`. Without this, v1 alias-heavy
  graphs arrive with `//` baked into titles and every aliased link breaks.
- **Collision surfacing.** Neither v1 nor v2 warns when two notes claim the
  same alias. Worth a lint-style indicator eventually, but not a porting
  blocker.
