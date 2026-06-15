/**
 * The GFM checkbox marker (Plan 18) — the one definition of "what is a task
 * marker", shared by extraction ({@link parseNote}, which finds task lines) and
 * the toggle ({@link toggleTaskMarker}, which rewrites them). Keeping it here
 * means the two can never disagree about which `[ ]`/`[x]` lines are tasks: a
 * marker the extractor accepts but the toggle rejects (or vice versa) would be a
 * silent stale read or a no-op write.
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
