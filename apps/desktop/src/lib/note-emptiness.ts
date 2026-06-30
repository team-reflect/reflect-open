import { splitFrontmatter } from '@reflect/core'

const EMPTY_PLAIN_BULLET_LINE = /^[ \t]*[-+*][ \t]*$/

function isOstensiblyEmptyLine(line: string): boolean {
  return line.trim() === '' || EMPTY_PLAIN_BULLET_LINE.test(line)
}

/**
 * Whether a note's visible markdown body has no authored content. Frontmatter
 * is metadata and does not count; a bare unordered-list marker is also empty
 * because daily notes can open on a starter bullet before the user types.
 */
export function isOstensiblyEmptyNoteSource(source: string): boolean {
  const { body } = splitFrontmatter(source)
  return body.split(/\r?\n/).every(isOstensiblyEmptyLine)
}
