import { splitFrontmatter } from './frontmatter'
import { parseBody } from './grammar'
import type { Heading } from './model'

/** Return only headings represented by top-level Markdown blocks. */
export function topLevelHeadings(
  source: string,
  headings: readonly Heading[],
): readonly Heading[] {
  const { body, bodyOffset } = splitFrontmatter(source)
  const headingOffsets = new Set<number>()
  for (
    let block = parseBody(body).topNode.firstChild;
    block !== null;
    block = block.nextSibling
  ) {
    if (/^(?:ATX|Setext)Heading[1-6]$/.test(block.name)) {
      headingOffsets.add(bodyOffset + block.from)
    }
  }
  return headings.filter((heading) => headingOffsets.has(heading.from))
}
