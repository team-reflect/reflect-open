import { parseNote } from './extract'
import type { Heading } from './model'

/**
 * Source-level edit helpers (Plan 03). These splice the original string by node
 * position rather than re-serializing the document, so untouched bytes — and
 * thus sync diffs (Plan 12) — stay minimal. (Frontmatter edits live in
 * `frontmatter.ts`'s `upsertFrontmatter`.)
 */

/** The three GFM checkbox markers a task line can carry (`[X]` is GitHub-valid). */
const TASK_MARKERS = new Set(['[ ]', '[x]', '[X]'])

/**
 * The indexed task no longer matches the source, so toggling it would edit the
 * wrong line. Thrown by {@link toggleTaskMarker}; the caller refuses loudly and
 * reindexes rather than writing a silent wrong edit (Plan 18).
 */
export class TaskStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskStaleError'
  }
}

/**
 * Locate the task marker in `source`: trust `markerOffset` when the recorded
 * marker line (`raw`) still sits exactly there, else re-extract the note's tasks
 * and match the unique one whose marker line is `raw`. Re-extracting (rather than
 * a raw string search) means the relocation can only ever land on a real task
 * line — never a coincidental mid-line or in-code-block occurrence of `raw` — so
 * an edit *above* the task is tolerated without risking a wrong-line toggle.
 * Throws {@link TaskStaleError} when `raw` matches no task, or more than one.
 */
function locateTaskMarker(source: string, markerOffset: number, raw: string): number {
  if (source.slice(markerOffset, markerOffset + raw.length) === raw) {
    return markerOffset
  }
  const matches = parseNote({ path: '', source }).tasks.filter((task) => task.raw === raw)
  if (matches.length === 0) {
    throw new TaskStaleError(`task line no longer in note: ${JSON.stringify(raw)}`)
  }
  if (matches.length > 1) {
    throw new TaskStaleError(`task line is ambiguous: ${JSON.stringify(raw)}`)
  }
  return matches[0].markerOffset
}

/**
 * Toggle a GFM checkbox between `[ ]` and `[x]` by splicing exactly the three
 * marker characters — the file changes by the marker alone, nothing else. The
 * task is located by {@link locateTaskMarker}; a stale or ambiguous location, or
 * a position that no longer holds a marker, throws {@link TaskStaleError} rather
 * than writing the wrong line. Returns the new source and the new checked state.
 */
export function toggleTaskMarker(
  source: string,
  task: { markerOffset: number; raw: string },
): { source: string; checked: boolean } {
  const offset = locateTaskMarker(source, task.markerOffset, task.raw)
  const marker = source.slice(offset, offset + 3)
  if (!TASK_MARKERS.has(marker)) {
    throw new TaskStaleError(`no task marker at offset ${offset}: ${JSON.stringify(marker)}`)
  }
  const wasChecked = marker !== '[ ]'
  const next = wasChecked ? '[ ]' : '[x]'
  return {
    source: source.slice(0, offset) + next + source.slice(offset + 3),
    checked: !wasChecked,
  }
}

interface Splice {
  from: number
  to: number
  text: string
}

/** Apply non-overlapping splices, right-to-left so earlier offsets stay valid. */
function applySplices(source: string, splices: Splice[]): string {
  let result = source
  for (const splice of [...splices].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, splice.from) + splice.text + result.slice(splice.to)
  }
  return result
}

/**
 * Rewrite the target of every `[[from]]` / `[[from|alias]]` to `to`
 * (case-insensitive match on the trimmed target), preserving each alias and all
 * surrounding text. Used by the rename-rewrite flow.
 */
export function renameWikiLink(source: string, from: string, to: string): string {
  // `[[…]]` has no escaping, so a target can't contain the bracket/pipe/newline
  // characters that delimit the syntax — writing one would corrupt the link.
  if (/[[\]|\r\n]/.test(to)) {
    throw new Error(`invalid wiki-link target (cannot contain [ ] | or a newline): ${to}`)
  }
  const fromKey = from.trim().toLowerCase()
  const { wikiLinks } = parseNote({ path: '', source })
  const splices = wikiLinks
    .filter((link) => link.target.toLowerCase() === fromKey)
    .map<Splice>((link) => ({
      from: link.from,
      to: link.to,
      text: link.alias ? `[[${to}|${link.alias}]]` : `[[${to}]]`,
    }))
  return applySplices(source, splices)
}

function nextSectionStart(headings: Heading[], target: Heading, eof: number): number {
  const next = headings.find((heading) => heading.from > target.from && heading.level <= target.level)
  return next ? next.from : eof
}

/**
 * Insert `block` at the end of the section under the first heading whose text
 * matches `heading` (case-insensitive). If no such heading exists, append a new
 * `## heading` section at end of file. Used by capture (Plan 11).
 */
/**
 * Append `block` as its own paragraph at the end of the note, one blank line
 * after the existing content (none for an empty note). The flat variant of
 * {@link appendUnderHeading} — used by audio-memo capture, where the
 * transcript reads as ordinary note content rather than a section entry.
 */
export function appendBlock(source: string, block: string): string {
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}\n\n` : ''
  return `${prefix}${block.trim()}\n`
}

export function appendUnderHeading(source: string, heading: string, block: string): string {
  const headingKey = heading.trim().toLowerCase()
  const { headings } = parseNote({ path: '', source })
  const target = headings.find((candidate) => candidate.text.toLowerCase() === headingKey)

  if (!target) {
    const base = source.replace(/\s*$/, '')
    const prefix = base.length > 0 ? `${base}\n\n` : ''
    return `${prefix}## ${heading.trim()}\n\n${block}\n`
  }

  const sectionEnd = nextSectionStart(headings, target, source.length)
  const head = source.slice(0, sectionEnd).replace(/\s*$/, '')
  const tail = source.slice(sectionEnd)
  const inserted = `${head}\n\n${block}`
  return tail ? `${inserted}\n\n${tail}` : `${inserted}\n`
}
