/**
 * One line-ending policy for every source-level edit. Markdown is the source of
 * truth and may be authored on Windows or arrive through a checkout with CRLF,
 * so an automatic write that swaps a file's line endings shows up as a whole-line
 * diff in sync (Plan 03's round-trip requirement). Every helper that splices new
 * lines into a note asks here rather than hard-coding `\n`.
 */
export type LineEnding = '\r\n' | '\n'

/** The document's convention, taken from its first line break. */
export function documentLineEnding(source: string): LineEnding {
  const newline = source.indexOf('\n')
  return newline > 0 && source[newline - 1] === '\r' ? '\r\n' : '\n'
}

/**
 * The line ending in use at `offset`: the break starting there, else the one
 * that ended the preceding line, else the document's convention.
 */
export function lineEndingAt(source: string, offset: number): LineEnding {
  if (source.startsWith('\r\n', offset)) {
    return '\r\n'
  }
  if (source[offset] === '\n') {
    return '\n'
  }
  const previousNewline = source.lastIndexOf('\n', offset - 1)
  if (previousNewline === -1) {
    return documentLineEnding(source)
  }
  return source[previousNewline - 1] === '\r' ? '\r\n' : '\n'
}

/**
 * Lezer ends a CRLF-terminated range *between* the `\r` and the `\n`, so a
 * splice at a node's `to` would land inside the pair and orphan a lone `\n`.
 * Back up onto the `\r` when that is where `offset` sits.
 */
export function offsetBeforeLineEnding(source: string, offset: number): number {
  return source[offset - 1] === '\r' && source[offset] === '\n' ? offset - 1 : offset
}
