# Porting note aliases

**Status: ported.** Frontmatter aliases shipped with readable filenames
([docs/readable-filenames.md](../readable-filenames.md)); direct support for
v1 `//` titles followed in `v0.4.0-beta.31` and stable `v0.4.0`.

## What v1 did

Aliases were part of the title: an H1 of `Superman // Clark Kent // Kal‑El`
made each segment after `//` an alias. `[[` autocomplete matched aliases,
links through any spelling resolved to the canonical note, and backlinks
aggregated under the canonical title. A saved v1 link carried the target's
stable ID as well as its label, so it survived a rename even when the old
spelling left the title (the label could go stale).

## How v2 does it

Frontmatter is the native files-first form:

```yaml
---
id: 01J9ZK...
aliases:
  - Clark Kent
  - Kal-El
---

# Superman
```

- `aliases` is a plain YAML string array
  (`packages/core/src/markdown/model.ts`); malformed values degrade to an
  empty list.
- V1 titles work without conversion. For `# Tim MacCaw // Dad`, the full H1
  stays the canonical title, and `Tim MacCaw` and `Dad` become derived
  aliases in the rebuildable index. The file is not rewritten.
- Reader-facing surfaces show a `//` title by its first segment, as v1 did:
  All Notes, the ⌘K palette, backlink and similar-note lists, task groups,
  the window title, wiki-link chips, and `reflect search` all read
  `Tim MacCaw`. The full H1 stays the canonical title, resolution key, link
  target, and filename slug; the editor shows the full H1 for editing. A
  chip for `[[Tim MacCaw // Dad]]` reads `Tim MacCaw`;
  `[[Tim MacCaw // Dad|Dad]]` keeps `Dad`. When ⌘K matched a segment, the
  row shows `Dad → Tim MacCaw`.
- `[[Dad]]` resolves to that note and counts as its backlink. Choosing the
  `Dad` autocomplete match writes `[[Tim MacCaw // Dad|Dad]]`. Unlike v1's
  ID-backed links, this is a textual address: if another note wins the
  full-title key, the alias is used when it uniquely resolves to the
  selected note. A note with no winning textual key is omitted from `[[`
  autocomplete instead of linking a different note.
- Read-only resolution and backlinks are deterministic: a calendar-valid
  daily date wins, then an exact title, then an alias; collisions within a
  tier choose the first graph-relative path alphabetically. The `note_keys`
  view holds that winner plus the tier's claim count. Writable navigation
  refuses an ambiguous winning tier, and `[[` autocomplete omits the same
  ambiguous address unless a unique alias can address the note. Clicking a
  valid ISO date with an unclaimed key still opens or lazily creates that
  daily.
- Renames are **stronger than v1**: the rename coordinator
  (`packages/core/src/documents/title-rename-service.ts`) rewrites known
  `[[old title]]` links, then records the old title as an alias so
  unindexed or external references keep resolving.
- Since the whole `Tim MacCaw // Dad` H1 is the canonical title, changing
  only `Dad` is a normal title rename (it can rename the file and rewrite
  links); `//` is compatibility syntax, not a stored alias field. Use
  frontmatter `aliases` when the distinction matters. A rename records each
  old segment as well as the old title, so `[[Dad]]` and `[[Tim MacCaw]]`
  still resolve after the H1 becomes `# Timothy MacCaw`; segments the new
  title keeps are not recorded.
- Daily notes may carry frontmatter or `//` aliases; their date stays the
  strongest address for the ISO-date key.
- `[[target|shown text]]` display text is a per-link cosmetic v1 lacked,
  distinct from aliases (which affect resolution).

## v1 → v2 mapping

| v1                                               | v2                                                              |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `Title // Alias1 // Alias2` in the H1            | Supported directly; segments become derived index aliases and `Title` is the displayed title |
| Existing links keep working by stable target ID  | Textual links are rewritten; old title is preserved as alias    |
| No alias UI beyond the title bar                 | `//` remains available; frontmatter aliases are also editable   |
| Daily links target the note's stable identity    | Date wins its key; daily notes may also project aliases         |
| Alias collisions: first match wins, silently     | Read winner is deterministic; writable ambiguity is refused    |

## Diagnosing an alias report

1. Check the version. Direct `//` support starts in `v0.4.0-beta.31` and
   stable `v0.4.0`; earlier builds treat the H1 as one literal title.
   Upgrading triggers the projection-version rebuild that adds the aliases.
2. Look for a standalone note whose full title is the alias, e.g. `# Dad`
   created by an older build when `[[Dad]]` looked unresolved. That exact
   title intentionally wins over the `Dad` alias for navigation, backlinks,
   and autocomplete.
3. If both notes are intentional, link the canonical target explicitly
   (`[[Tim MacCaw // Dad|Dad]]`). Otherwise rename or remove the accidental
   note so `[[Dad]]` resolves through the alias. Duplicate full titles are
   ambiguous for writable navigation; give the intended note a unique alias
   and `[[` autocomplete offers it through that alias.

## Open porting task

- **Collision surfacing.** Writable navigation reports ambiguity, but there
  is no persistent indicator listing title or alias collisions. Worth
  adding; not a blocker.
