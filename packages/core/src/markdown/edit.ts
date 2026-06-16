import { parseNote } from './extract'
import { normalizeWikiTarget } from './resolve'
import { scanInlineWikiLinks } from './scan'
import { parseTaskMarker } from './task-marker'
import type { Heading, TaskMarker } from './model'

/**
 * Source-level edit helpers (Plan 03). These splice the original string by node
 * position rather than re-serializing the document, so untouched bytes — and
 * thus sync diffs (Plan 12) — stay minimal. (Frontmatter edits live in
 * `frontmatter.ts`'s `upsertFrontmatter`.)
 */

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
  // Re-extract: the recorded offset is trusted only when it still holds a real
  // parsed task with this line — a byte match alone isn't enough, since an edit
  // above could have turned the line into (say) code without changing its bytes.
  const tasks = parseNote({ path: '', source }).tasks
  if (tasks.some((task) => task.markerOffset === markerOffset && task.raw === raw)) {
    return markerOffset
  }
  const matches = tasks.filter((task) => task.raw === raw)
  if (matches.length === 0) {
    throw new TaskStaleError(`task line no longer in note: ${JSON.stringify(raw)}`)
  }
  if (matches.length > 1) {
    throw new TaskStaleError(`task line is ambiguous: ${JSON.stringify(raw)}`)
  }
  return matches[0]!.markerOffset
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
  task: TaskMarker,
): { source: string; checked: boolean } {
  const offset = locateTaskMarker(source, task.markerOffset, task.raw)
  const marker = source.slice(offset, offset + 3)
  const parsed = parseTaskMarker(marker)
  if (parsed === null) {
    throw new TaskStaleError(`no task marker at offset ${offset}: ${JSON.stringify(marker)}`)
  }
  const next = parsed.checked ? '[ ]' : '[x]'
  return {
    source: source.slice(0, offset) + next + source.slice(offset + 3),
    checked: !parsed.checked,
  }
}

/**
 * Replace a task's content — everything after its `[ ]`/`[x]` marker — with
 * `content`, leaving the list bullet, indentation, and the marker (and so its
 * checked state) untouched. The task is located by {@link locateTaskMarker}, the
 * same staleness guard the toggle uses, so a drifted or ambiguous line refuses
 * loudly rather than editing the wrong row. `content` is one line of markdown
 * (the inline editor's serialization); an embedded newline would split the item
 * into fresh lines or tasks, so it throws. Empty content is the caller's signal
 * to delete (see {@link removeTaskLine}) — here it just clears to a bare marker.
 */
export function editTaskLine(source: string, task: TaskMarker, content: string): string {
  const text = content.trim()
  if (text.includes('\n') || text.includes('\r')) {
    throw new TaskStaleError(`task content must be a single line: ${JSON.stringify(content)}`)
  }
  const offset = locateTaskMarker(source, task.markerOffset, task.raw)
  const marker = source.slice(offset, offset + 3)
  if (parseTaskMarker(marker) === null) {
    throw new TaskStaleError(`no task marker at offset ${offset}: ${JSON.stringify(marker)}`)
  }
  const newline = source.indexOf('\n', offset)
  const lineEnd = newline === -1 ? source.length : newline
  const rewritten = text.length > 0 ? `${marker} ${text}` : marker
  return source.slice(0, offset) + rewritten + source.slice(lineEnd)
}

/**
 * Remove a task's whole physical line — its list bullet, marker, and content —
 * along with the trailing newline, so deleting a middle task closes the gap and
 * deleting the only task empties the note. Located by {@link locateTaskMarker};
 * a stale or ambiguous line refuses loudly. Continuation lines of a multi-line
 * item aren't removed — the projection (and so a task's identity) is one line.
 */
export function removeTaskLine(source: string, task: TaskMarker): string {
  const offset = locateTaskMarker(source, task.markerOffset, task.raw)
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  const newline = source.indexOf('\n', offset)
  const lineEnd = newline === -1 ? source.length : newline + 1
  return source.slice(0, lineStart) + source.slice(lineEnd)
}

/**
 * Append a new empty task — a `- [ ] ` line — to the end of `source`, returning
 * the new source and the marker's offset (the `[`). The Tasks view's Return-to-add
 * (Plan 18) writes the empty line, then the inline editor on the new row fills it.
 * A single newline separates it from existing content (continuing a trailing
 * list, or interrupting a paragraph — a non-empty task item is allowed to); an
 * empty note just becomes the one task. The trailing space keeps it a valid GFM
 * checkbox and seats the caret.
 */
export function appendTaskLine(source: string): { source: string; markerOffset: number } {
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}\n- ` : '- '
  return { source: `${prefix}[ ] \n`, markerOffset: prefix.length }
}

/**
 * Demote a task back to a plain bullet by removing exactly its `[ ]`/`[x]` marker
 * and the run of horizontal whitespace after it — `- [ ] text` becomes `- text`,
 * the list bullet, indentation, and content all untouched. This is the Tasks
 * view's "Convert to bullet" (Plan 18 follow-up): a GFM checkbox is the only
 * thing the projection treats as a task, so dropping the marker lifts the item
 * out of the Tasks view while keeping it in the note as ordinary markdown — no
 * invented syntax, unlike a per-item checklist flag. Located by {@link
 * locateTaskMarker}, the same staleness guard the toggle uses, so a drifted or
 * ambiguous line — or a position that no longer holds a marker — refuses loudly
 * with {@link TaskStaleError} rather than rewriting the wrong line. An empty task
 * (`- [ ] `) collapses to a bare bullet (`- `).
 */
export function taskLineToBullet(source: string, task: TaskMarker): string {
  const offset = locateTaskMarker(source, task.markerOffset, task.raw)
  const marker = source.slice(offset, offset + 3)
  if (parseTaskMarker(marker) === null) {
    throw new TaskStaleError(`no task marker at offset ${offset}: ${JSON.stringify(marker)}`)
  }
  let contentStart = offset + 3
  while (
    contentStart < source.length &&
    (source[contentStart] === ' ' || source[contentStart] === '\t')
  ) {
    contentStart += 1
  }
  return source.slice(0, offset) + source.slice(contentStart)
}

/**
 * Schedule a task by setting its due date to `isoDate` (a `YYYY-MM-DD`), working
 * on the task's **content** — the markdown after the marker. A task's due date is
 * the first calendar-valid `[[YYYY-MM-DD]]` link inside it (the same rule the
 * projection reads), so this replaces that link's target when one exists, else
 * appends `[[isoDate]]` to the content. Returned content is fed back through
 * {@link editTaskLine}; the caller supplies a valid ISO date (the calendar only
 * yields real days).
 */
export function setTaskDueDate(content: string, isoDate: string): string {
  const existing = scanInlineWikiLinks(content).find(
    (link) => normalizeWikiTarget(link.target).date !== undefined,
  )
  if (existing !== undefined) {
    return content.slice(0, existing.from) + `[[${isoDate}]]` + content.slice(existing.to)
  }
  const trimmed = content.replace(/\s+$/, '')
  return trimmed.length > 0 ? `${trimmed} [[${isoDate}]]` : `[[${isoDate}]]`
}

/**
 * Unschedule a task: drop its first calendar-valid `[[YYYY-MM-DD]]` due-date link
 * from the content (collapsing the surrounding whitespace), or return the content
 * unchanged when it has no due date. The inverse of {@link setTaskDueDate}.
 */
export function clearTaskDueDate(content: string): string {
  const existing = scanInlineWikiLinks(content).find(
    (link) => normalizeWikiTarget(link.target).date !== undefined,
  )
  if (existing === undefined) {
    return content
  }
  const removed = content.slice(0, existing.from) + content.slice(existing.to)
  return removed.replace(/[ \t]{2,}/g, ' ').trim()
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
