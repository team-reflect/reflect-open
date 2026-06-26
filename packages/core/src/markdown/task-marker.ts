/**
 * The GFM checkbox state marker (Plan 18), shared by extraction ({@link parseNote})
 * and the toggle ({@link toggleTaskMarker}). Extraction decides which list markers
 * are Reflect tasks; this helper decides whether the three-character checkbox
 * marker itself is valid and whether it is checked.
 */

/** The three GFM checkbox markers a task line can carry (`[X]` is GitHub-valid). */
const TASK_MARKERS = new Set(['[ ]', '[x]', '[X]'])

/**
 * Parse the three-character GFM checkbox marker `marker` — typically
 * `source.slice(from, from + 3)` — into its checked state, or `null` when it
 * isn't a real marker. A short slice (end of file) or any other shape returns
 * `null`, so this doubles as the defensive guard against parser surprises and
 * stale offsets alike.
 */
export function parseTaskMarker(marker: string): { checked: boolean } | null {
  if (!TASK_MARKERS.has(marker)) {
    return null
  }
  return { checked: marker !== '[ ]' }
}
