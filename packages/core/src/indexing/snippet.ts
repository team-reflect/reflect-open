/**
 * Line-level context extraction for the backlinks panel (Plan 07): given a
 * note's source and a link's whole-file offset (the index stores `pos_from`
 * with the frontmatter offset already applied), return the surrounding line,
 * trimmed around the position when the line runs long.
 */

const DEFAULT_MAX_LENGTH = 160
const PREVIEW_MAX_LENGTH = 120

/** The single line of `content` containing `pos`, windowed to `maxLength`. */
export function lineSnippet(content: string, pos: number, maxLength = DEFAULT_MAX_LENGTH): string {
  const at = Math.max(0, Math.min(pos, content.length))
  const lineStart = content.lastIndexOf('\n', Math.max(0, at - 1)) + 1
  const lineEndRaw = content.indexOf('\n', at)
  const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw
  const rawLine = content.slice(lineStart, lineEnd)
  const line = rawLine.trim()
  if (line.length <= maxLength) {
    return line
  }
  // Window around the link's position within the *trimmed* line — the trim
  // shifted offsets by the leading whitespace, and on a long indented line an
  // unadjusted position could window the link right out of the snippet.
  const startTrim = rawLine.length - rawLine.trimStart().length
  const posInLine = Math.max(0, Math.min(at - lineStart - startTrim, line.length))
  const half = Math.floor(maxLength / 2)
  const from = Math.max(0, Math.min(posInLine - half, line.length - maxLength))
  const to = from + maxLength
  const prefix = from > 0 ? '…' : ''
  const suffix = to < line.length ? '…' : ''
  return `${prefix}${line.slice(from, to).trim()}${suffix}`
}

/**
 * A list-row preview of a note from the index's plain text. `buildPlainText`
 * collapses all whitespace to single spaces — there are no lines to split on —
 * so the preview is the collapsed text with the title dropped when it leads it
 * (heading *text* survives the markup cuts, so most notes open with their own
 * title — pure noise next to a Subject column). The strip is whole-word: a
 * title that is merely a prefix of the first word (`Health` / `Healthy…`)
 * stays put. Raw multi-line input is collapsed the same way first, so the
 * function is total over both the stored text and any fresher source.
 */
export function previewSnippet(
  text: string,
  title: string,
  maxLength = PREVIEW_MAX_LENGTH,
): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const foldedTitle = title.replace(/\s+/g, ' ').trim()
  let body = collapsed
  if (foldedTitle !== '') {
    if (body === foldedTitle) {
      body = ''
    } else if (body.startsWith(`${foldedTitle} `)) {
      body = body.slice(foldedTitle.length + 1)
    }
  }
  return body.length <= maxLength ? body : `${body.slice(0, maxLength).trimEnd()}…`
}
