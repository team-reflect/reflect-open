/**
 * Pure helpers for the graph's on-disk path conventions (Plan 02). These build
 * and recognize **graph-relative** paths; the Rust layer owns the root and the
 * traversal guard. Shared by every later phase (daily notes, backlinks, CLI).
 */

export const DAILY_DIR = 'daily'
export const NOTES_DIR = 'notes'
export const ASSETS_DIR = 'assets'
/** Audio-memo recordings live apart from pasted/dropped `assets/` files. */
export const AUDIO_MEMOS_DIR = 'audio-memos'

/** Matches a daily-note path and captures its ISO date. */
const DAILY_PATH_RE = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/
/** A bare ISO date (`YYYY-MM-DD`). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Graph-relative path to a daily note for an ISO `YYYY-MM-DD` date. */
export function dailyPath(date: string): string {
  if (!ISO_DATE_RE.test(date)) {
    throw new Error(`dailyPath expects an ISO YYYY-MM-DD date, got: ${date}`)
  }
  // Reject well-formatted but invalid dates (e.g. 2026-13-99, 2026-02-31) by
  // round-tripping through UTC and comparing the components. The regex above
  // guarantees three numeric parts, so the destructure can't yield undefined.
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error(`dailyPath expects a valid calendar date, got: ${date}`)
  }
  return `${DAILY_DIR}/${date}.md`
}

/** Graph-relative path to a regular note for a filename slug (without `.md`). */
export function notePath(slug: string): string {
  return `${NOTES_DIR}/${slug}.md`
}

/** Graph-relative path to an attachment under `assets/`. */
export function assetPath(name: string): string {
  return `${ASSETS_DIR}/${name}`
}

/** Graph-relative path to a stored recording under `audio-memos/`. */
export function audioMemoPath(name: string): string {
  return `${AUDIO_MEMOS_DIR}/${name}`
}

/** Is this graph-relative path a daily note (`daily/YYYY-MM-DD.md`)? */
export function isDaily(path: string): boolean {
  return DAILY_PATH_RE.test(path)
}

/**
 * Is this graph-relative path an indexable markdown note (`.md` under
 * `daily/` or `notes/`)? The file-change stream carries more than notes —
 * the watcher also reports `audio-memos/` recordings — so consumers that
 * read or index note *content* gate on this.
 */
export function isNotePath(path: string): boolean {
  return (
    (path.startsWith(`${DAILY_DIR}/`) || path.startsWith(`${NOTES_DIR}/`)) && path.endsWith('.md')
  )
}

/** Extract the ISO date from a daily-note path, or `null` if it isn't one. */
export function dateFromDailyPath(path: string): string | null {
  return DAILY_PATH_RE.exec(path)?.[1] ?? null
}
