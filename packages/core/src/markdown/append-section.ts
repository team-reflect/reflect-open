/**
 * Append `block` as its own paragraph at the end of the note, one blank line
 * after the existing content (none for an empty note). For content that stands
 * on its own rather than landing under a section heading.
 */
export function appendBlock(source: string, block: string): string {
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}\n\n` : ''
  return `${prefix}${block.trim()}\n`
}

/** Append a new H2 section. */
export function appendHeadingSection(source: string, heading: string, block: string): string {
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}\n\n` : ''
  return `${prefix}## ${heading.trim()}\n\n${block}\n`
}
