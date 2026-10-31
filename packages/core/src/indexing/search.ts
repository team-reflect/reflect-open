/**
 * Search-highlight plumbing for indexed snippets and query-matched titles.
 * The search itself lives in `filtered-search.ts` — one ranked, snippeted
 * query whose filters may be empty, so there is exactly one search path to
 * keep correct.
 * Highlight boundaries use control-character markers so {@link parseHighlights}
 * can split them without ever confusing user text for markup.
 */

/** Marks the start/end of a highlighted match inside a snippet. */
export const HIGHLIGHT_START = '\u{1}'
export const HIGHLIGHT_END = '\u{2}'

/** One run of display text, highlighted or plain. */
export interface HighlightSegment {
  text: string
  highlighted: boolean
}

/** Split a marker-bearing snippet into renderable segments. */
export function parseHighlights(snippet: string): HighlightSegment[] {
  const segments: HighlightSegment[] = []
  let rest = snippet
  let highlighted = false
  while (rest !== '') {
    // Alternate between looking for the opening and closing marker.
    const at = rest.indexOf(highlighted ? HIGHLIGHT_END : HIGHLIGHT_START)
    if (at === -1) {
      segments.push({ text: rest, highlighted })
      break
    }
    if (at > 0) {
      segments.push({ text: rest.slice(0, at), highlighted })
    }
    rest = rest.slice(at + 1)
    highlighted = !highlighted
  }
  return segments
}
