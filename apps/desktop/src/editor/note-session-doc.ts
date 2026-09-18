import { documentLineEnding, splitFrontmatter } from '@reflect/core'

/**
 * The frontmatter block (may be empty) and the body that follows it. The block
 * always ends with its blank separator line, so a body that opens with a blank
 * line keeps it on the next read.
 */
export function splitDoc(content: string): { header: string; body: string } {
  const { raw, body, bodyOffset } = splitFrontmatter(content)
  if (raw === null) {
    return { header: '', body }
  }
  const lineEnding = documentLineEnding(content)
  return { header: content.slice(0, bodyOffset).trimEnd() + lineEnding + lineEnding, body }
}
