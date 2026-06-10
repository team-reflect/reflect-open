import { sql } from 'kysely'
import { db } from './db'

/**
 * Snippet-highlight plumbing for palette search (Plan 08). The search itself
 * lives in `filtered-search.ts` — one ranked, snippeted query whose filters
 * may be empty, so there is exactly one search path to keep correct.
 * Highlight boundaries use control-character markers so {@link parseHighlights}
 * can split them without ever confusing user text for markup.
 */

/** Marks the start/end of a highlighted match inside a snippet. */
export const HIGHLIGHT_START = '\u0001'
export const HIGHLIGHT_END = '\u0002'

/** One run of snippet text, highlighted or plain. */
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

/** A uniformly random note path, or null on an empty graph (Plan 08 command). */
export async function randomNotePath(): Promise<string | null> {
  const result = await sql<{ path: string }>`
    SELECT path FROM notes ORDER BY random() LIMIT 1
  `.execute(db)
  return result.rows[0]?.path ?? null
}
