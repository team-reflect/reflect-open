import { parseNote } from './extract'
import { sectionEnd, topLevelHeadings } from './heading-blocks'

function documentLineEnding(source: string): '\r\n' | '\n' {
  const newline = source.indexOf('\n')
  return newline > 0 && source[newline - 1] === '\r' ? '\r\n' : '\n'
}

/**
 * Append `block` as its own paragraph at the end of the note, one blank line
 * after the existing content (none for an empty note).
 */
export function appendBlock(source: string, block: string): string {
  const lineEnding = documentLineEnding(source)
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}${lineEnding.repeat(2)}` : ''
  return `${prefix}${block.trim()}${lineEnding}`
}

/** Append a new H2 section using the document's existing line ending. */
export function appendHeadingSection(source: string, heading: string, block: string): string {
  const lineEnding = documentLineEnding(source)
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}${lineEnding.repeat(2)}` : ''
  return `${prefix}## ${heading.trim()}${lineEnding.repeat(2)}${block}${lineEnding}`
}

/**
 * Insert `block` at the end of the section under the first top-level heading
 * whose text matches `heading` (case-insensitive). If no such heading exists,
 * append a new H2 section.
 */
export function appendUnderHeading(source: string, heading: string, block: string): string {
  const headingKey = heading.trim().toLowerCase()
  const { headings } = parseNote({ path: '', source })
  const sectionHeadings = topLevelHeadings(source, headings)
  const target = sectionHeadings.find(
    (candidate) => candidate.text.toLowerCase() === headingKey,
  )

  if (target === undefined) {
    return appendHeadingSection(source, heading, block)
  }

  const lineEnding = documentLineEnding(source)
  const insertionOffset = sectionEnd(sectionHeadings, target, source.length)
  const head = source.slice(0, insertionOffset).replace(/\s*$/, '')
  const tail = source.slice(insertionOffset)
  const inserted = `${head}${lineEnding.repeat(2)}${block}`
  return tail
    ? `${inserted}${lineEnding.repeat(2)}${tail}`
    : `${inserted}${lineEnding}`
}
