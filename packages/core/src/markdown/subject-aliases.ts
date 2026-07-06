/**
 * Reflect V1 subject aliases — the `//` convention inside note titles
 * (`Charlotte MacCaw // Mum`), where every segment matches or is suggested
 * like an alias (see docs/reflect-v1-overview.md, "Backlinks and Aliases").
 *
 * V2's canonical alias mechanism is `aliases:` frontmatter; this module is a
 * derived compatibility layer for imported or v1-style-authored titles. The
 * segments are computed at index time and land in the same `aliases`
 * projection — nothing is migrated into frontmatter, and the title itself
 * stays the literal `//` string.
 *
 * Mirrored by `subject_aliases` in the CLI (`apps/cli/src/note_file.rs`);
 * the parity corpus (`fixtures/parity/`) keeps the two in lockstep.
 */

import { foldKey } from './keys'

/**
 * A `//` separator: exactly two slashes, not preceded by `:` or `/` and not
 * followed by `/`, so URL schemes (`https://…`) and slash runs never split.
 */
const SUBJECT_ALIAS_SEPARATOR = /(?<![:/])\/\/(?!\/)/

/**
 * The v1 subject aliases derived from `title`, in title order: each `//`
 * segment, trimmed, empty segments dropped, deduplicated by {@link foldKey}.
 * A title with no separator has none. The first segment is included —
 * `[[Charlotte MacCaw]]` must resolve to `Charlotte MacCaw // Mum` too.
 */
export function subjectAliases(title: string): string[] {
  const segments = title.split(SUBJECT_ALIAS_SEPARATOR)
  if (segments.length < 2) {
    return []
  }
  const seen = new Set<string>()
  const aliases: string[] = []
  for (const segment of segments) {
    const alias = segment.trim()
    if (alias === '') {
      continue
    }
    const key = foldKey(alias)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    aliases.push(alias)
  }
  return aliases
}
