import { splitFrontmatter } from '@reflect/core'

/**
 * Whether a note's visible markdown body has no authored content. Frontmatter
 * is metadata and does not count; a bare unordered-list marker is also empty
 * because daily notes can open on a starter bullet before the user types.
 */
export function isOstensiblyEmptyNoteSource(source: string): boolean {
  const { body } = splitFrontmatter(source)
  return body.replaceAll(/[-+*#>[\]\r\n\s]/g, '') === ''
}
