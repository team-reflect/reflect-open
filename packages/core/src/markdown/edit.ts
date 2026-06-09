import { parseNote } from './extract'
import type { Heading } from './model'

/**
 * Source-level edit helpers (Plan 03). These splice the original string by node
 * position rather than re-serializing the document, so untouched bytes — and
 * thus sync diffs (Plan 12) — stay minimal. (Frontmatter edits live in
 * `frontmatter.ts`'s `upsertFrontmatter`.)
 */

interface Splice {
  from: number
  to: number
  text: string
}

/** Apply non-overlapping splices, right-to-left so earlier offsets stay valid. */
function applySplices(source: string, splices: Splice[]): string {
  let result = source
  for (const splice of [...splices].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, splice.from) + splice.text + result.slice(splice.to)
  }
  return result
}

/**
 * Rewrite the target of every `[[from]]` / `[[from|alias]]` to `to`
 * (case-insensitive match on the trimmed target), preserving each alias and all
 * surrounding text. Used by the rename-rewrite flow.
 */
export function renameWikiLink(source: string, from: string, to: string): string {
  const fromKey = from.trim().toLowerCase()
  const { wikiLinks } = parseNote({ path: '', source })
  const splices = wikiLinks
    .filter((link) => link.target.toLowerCase() === fromKey)
    .map<Splice>((link) => ({
      from: link.from,
      to: link.to,
      text: link.alias ? `[[${to}|${link.alias}]]` : `[[${to}]]`,
    }))
  return applySplices(source, splices)
}

function nextSectionStart(headings: Heading[], target: Heading, eof: number): number {
  const next = headings.find((heading) => heading.from > target.from && heading.level <= target.level)
  return next ? next.from : eof
}

/**
 * Insert `block` at the end of the section under the first heading whose text
 * matches `heading` (case-insensitive). If no such heading exists, append a new
 * `## heading` section at end of file. Used by capture (Plan 11).
 */
export function appendUnderHeading(source: string, heading: string, block: string): string {
  const headingKey = heading.trim().toLowerCase()
  const { headings } = parseNote({ path: '', source })
  const target = headings.find((candidate) => candidate.text.toLowerCase() === headingKey)

  if (!target) {
    const base = source.replace(/\s*$/, '')
    const prefix = base.length > 0 ? `${base}\n\n` : ''
    return `${prefix}## ${heading.trim()}\n\n${block}\n`
  }

  const sectionEnd = nextSectionStart(headings, target, source.length)
  const head = source.slice(0, sectionEnd).replace(/\s*$/, '')
  const tail = source.slice(sectionEnd)
  const inserted = `${head}\n\n${block}`
  return tail ? `${inserted}\n\n${tail}` : `${inserted}\n`
}
