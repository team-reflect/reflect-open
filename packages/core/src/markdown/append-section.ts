import { parseNote } from './extract'
import { topLevelHeadings } from './heading-blocks'
import type { Heading } from './model'

function nextSectionStart(headings: readonly Heading[], target: Heading, eof: number): number {
  const next = headings.find((heading) => heading.from > target.from && heading.level <= target.level)
  return next ? next.from : eof
}

function documentLineEnding(source: string): '\r\n' | '\n' {
  const newline = source.indexOf('\n')
  return newline > 0 && source[newline - 1] === '\r' ? '\r\n' : '\n'
}

/**
 * Append `block` as its own paragraph at the end of the note, one blank line
 * after the existing content (none for an empty note).
 */
export function appendBlock(source: string, block: string): string {
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}\n\n` : ''
  return `${prefix}${block.trim()}\n`
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

  const sectionEnd = nextSectionStart(sectionHeadings, target, source.length)
  const head = source.slice(0, sectionEnd).replace(/\s*$/, '')
  const tail = source.slice(sectionEnd)
  const inserted = `${head}\n\n${block}`
  return tail ? `${inserted}\n\n${tail}` : `${inserted}\n`
}
