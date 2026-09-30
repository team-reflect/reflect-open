import {
  parseInline,
  parseMarkdownAst,
  serializeMarkdownAst,
  type MarkdownListItem,
} from '@meowdown/markdown'

/**
 * Keep an edited first paragraph from becoming another block when serialized.
 * Task markers protect the first line, but continuation lines and ordinary
 * bullets can expose block syntax. Escape those openers only if serialization
 * would otherwise change the paragraph. Never rewrite inline code or accept a
 * value (for example a blank line) that Markdown cannot store as one paragraph.
 */
export function protectTaskParagraph(item: MarkdownListItem): void {
  const paragraph = item.children[0]
  if (paragraph?.type !== 'paragraph') return
  const roundTrips = (value: string): boolean => {
    const serialized = serializeMarkdownAst({
      type: 'document',
      children: [{ ...item, children: [{ type: 'paragraph', value }] }],
    })
    const parsed = parseMarkdownAst(serialized)
    const node = parsed.children[0]
    return (
      parsed.children.length === 1 &&
      node?.type === 'listItem' &&
      node.kind === item.kind &&
      node.children.length === 1 &&
      node.children[0]?.type === 'paragraph' &&
      node.children[0].value === value
    )
  }
  if (roundTrips(paragraph.value)) return
  const inline = parseInline(paragraph.value)
  const escaped = paragraph.value.replaceAll(
    /(^|\n)([ \t]*)(\[[ x]\](?=\s|$)|#{1,6}(?=\s|$)|>|[+*-](?=\s|$)|(?:[-*_][ \t]*){3,}(?=\n|$)|=+(?=\s|$)|`{3,}|~{3,}|\$\$|<|\d+[.)](?=\s|$))/gi,
    (match: string, newline: string, indent: string, opener: string, offset: number) => {
      const from = offset + newline.length + indent.length
      if (inline.some((node) => node.from <= from && from < node.to)) return match
      const protectedOpener = /^\d/.test(opener)
        ? opener.slice(0, -1) + '\\' + opener.slice(-1)
        : '\\' + opener
      return newline + indent + protectedOpener
    },
  )
  if (!roundTrips(escaped)) {
    throw new Error(
      'This text cannot be saved as one task paragraph. Remove blank lines or block syntax and try again.',
    )
  }
  paragraph.value = escaped
}
