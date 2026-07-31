import { documentLineEnding } from './line-endings'

/**
 * Append `block` as its own paragraph at the end of the note, one blank line
 * after the existing content (none for an empty note). For content that stands
 * on its own rather than landing under a section heading.
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
