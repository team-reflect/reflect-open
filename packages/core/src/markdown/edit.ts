import type { SyntaxNode } from '@lezer/common'
import { parseNote } from './extract'
import { splitFrontmatter } from './frontmatter'
import { parseBody } from './grammar'
import { foldKey } from './keys'
import { normalizeWikiTarget } from './resolve'
import { scanInlineWikiLinks } from './scan'
import { parseTaskMarker } from './task-marker'
import { renamedBareWikiTarget } from './wiki-link-rewrite'
import type { Heading, TaskMarker, WikiLink } from './model'

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
  const contentEnd = lineEnd > offset && source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd
  const rewritten = text.length > 0 ? `${marker} ${text}` : marker
  return source.slice(0, offset) + rewritten + source.slice(contentEnd)
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
 * Append a new empty task — a `+ [ ] ` line — to the end of `source`, returning
 * the new source and the marker's offset (the `[`). The Tasks view's Return-to-add
 * (Plan 18) writes the empty line, then the inline editor on the new row fills it.
 * A single newline separates it from existing content (continuing a trailing
 * list, or interrupting a paragraph — a non-empty task item is allowed to); an
 * empty note just becomes the one task. The trailing space keeps it a valid GFM
 * checkbox and seats the caret.
 */
export function appendTaskLine(source: string): { source: string; markerOffset: number } {
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}\n+ ` : '+ '
  return { source: `${prefix}[ ] \n`, markerOffset: prefix.length }
}

function taskNodeAt(body: string, markerOffset: number): SyntaxNode | null {
  let node: SyntaxNode | null = parseBody(body).resolve(markerOffset, 1)
  while (node !== null && node.name !== 'Task') {
    node = node.parent
  }
  return node
}

function nearestParentListItem(taskNode: SyntaxNode): SyntaxNode | null {
  const ownItem = taskNode.parent
  if (ownItem?.name !== 'ListItem') {
    return null
  }
  for (let ancestor = ownItem.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.name === 'ListItem') {
      return ancestor
    }
  }
  return null
}

function insertionLineEnding(source: string, insertionOffset: number): '\r\n' | '\n' {
  if (source.startsWith('\r\n', insertionOffset)) {
    return '\r\n'
  }
  if (source[insertionOffset] === '\n') {
    return '\n'
  }
  const previousNewline = source.lastIndexOf('\n', insertionOffset - 1)
  return previousNewline > 0 && source[previousNewline - 1] === '\r' ? '\r\n' : '\n'
}

/**
 * Add an empty task to the end of `task`'s nearest parent-list context. The new
 * line reuses the task's exact indentation and round-list prefix, so parsing it
 * yields the same ancestor breadcrumbs. The indexed marker is relocated through
 * the normal stale guard first; a task that no longer has a parent context is
 * refused rather than silently appended at the note root.
 */
export function appendTaskToContext(
  source: string,
  task: TaskMarker,
): {
  source: string
  markerOffset: number
  anchorOffset: number
  insertionOffset: number
} {
  const locatedOffset = locateTaskMarker(source, task.markerOffset, task.raw)
  const { body, bodyOffset } = splitFrontmatter(source)
  const taskNode = taskNodeAt(body, locatedOffset - bodyOffset)
  const contextItem = taskNode === null ? null : nearestParentListItem(taskNode)
  if (contextItem === null) {
    throw new TaskStaleError('task no longer has a parent list context')
  }

  const contextEnd = bodyOffset + contextItem.to
  // Lezer's CRLF ranges end between `\r` and `\n`; splice before the pair so
  // the inserted line cannot inherit a lone LF at either boundary.
  const insertionOffset =
    source[contextEnd - 1] === '\r' && source[contextEnd] === '\n' ? contextEnd - 1 : contextEnd
  const lineStart = source.lastIndexOf('\n', locatedOffset - 1) + 1
  const linePrefix = source.slice(lineStart, locatedOffset)
  const lineEnding = insertionLineEnding(source, insertionOffset)
  const trailingLineEnding = insertionOffset === source.length ? lineEnding : ''
  const inserted = `${lineEnding}${linePrefix}[ ] ${trailingLineEnding}`
  return {
    source: source.slice(0, insertionOffset) + inserted + source.slice(insertionOffset),
    markerOffset: insertionOffset + lineEnding.length + linePrefix.length,
    anchorOffset: locatedOffset,
    insertionOffset,
  }
}

/**
 * Demote a task back to a plain bullet by removing exactly its `[ ]`/`[x]` marker
 * and the run of horizontal whitespace after it — `+ [ ] text` becomes `+ text`,
 * the list bullet, indentation, and content all untouched. This is the Tasks
 * view's "Convert to bullet" (Plan 18 follow-up): a GFM checkbox is the only
 * thing the projection treats as a task, so dropping the marker lifts the item
 * out of the Tasks view while keeping it in the note as ordinary markdown — no
 * invented syntax, unlike a per-item checklist flag. Located by {@link
 * locateTaskMarker}, the same staleness guard the toggle uses, so a drifted or
 * ambiguous line — or a position that no longer holds a marker — refuses loudly
 * with {@link TaskStaleError} rather than rewriting the wrong line. An empty task
 * (`+ [ ] `) collapses to a bare bullet (`+ `).
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
 * Rewrite every bare-title spelling of `from` to `to`, preserving an optional
 * `.md`, heading fragment, alias, and all surrounding text. Path-qualified
 * targets are deliberately excluded: note moves rewrite those by exact path.
 */
export function renameWikiLink(source: string, from: string, to: string): string {
  // `[[…]]` has no escaping, so a target can't contain the bracket/pipe/newline
  // characters that delimit the syntax — writing one would corrupt the link.
  if (/[[\]|\r\n]/.test(to)) {
    throw new Error(`invalid wiki-link target (cannot contain [ ] | or a newline): ${to}`)
  }
  const fromKey = foldKey(from)
  const { wikiLinks } = parseNote({ path: '', source })
  const splices = wikiLinks
    .map((link): Splice | null => {
      const target = renamedBareWikiTarget(link.target, fromKey, to)
      if (target === null) {
        return null
      }
      const authored = source.slice(link.from + 2, link.to - 2)
      const pipe = authored.indexOf('|')
      const hash = authored.slice(0, pipe === -1 ? authored.length : pipe).indexOf('#')
      const fragment = hash === -1 ? '' : authored.slice(hash, pipe === -1 ? authored.length : pipe)
      const alias = pipe === -1 ? '' : authored.slice(pipe)
      return {
        from: link.from,
        to: link.to,
        text: `[[${target}${fragment}${alias}]]`,
      }
    })
    .filter((splice): splice is Splice => splice !== null)
  return applySplices(source, splices)
}

function nextSectionStart(headings: Heading[], target: Heading, eof: number): number {
  const next = headings.find((heading) => heading.from > target.from && heading.level <= target.level)
  return next ? next.from : eof
}

/**
 * `[[…]]` has no escaping — strip the characters that would corrupt a link
 * before embedding untrusted text (a page title, a meeting name) in one.
 */
export function wikiLinkSafe(text: string): string {
  return text.replace(/[[\]|\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Append `block` as its own paragraph at the end of the note, one blank line
 * after the existing content (none for an empty note). The flat variant of
 * {@link appendUnderHeading}, for content that stands on its own rather than
 * landing under a section heading.
 */
export function appendBlock(source: string, block: string): string {
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}\n\n` : ''
  return `${prefix}${block.trim()}\n`
}

/**
 * Insert `block` at the end of the section under the first heading whose text
 * matches `heading` (case-insensitive). If no such heading exists, append a new
 * `## heading` section at end of file. Used by capture (Plan 11) and the
 * add-meeting action.
 */
export function appendUnderHeading(source: string, heading: string, block: string): string {
  const headingKey = heading.trim().toLowerCase()
  const { headings } = parseNote({ path: '', source })
  const target = headings.find((candidate) => candidate.text.toLowerCase() === headingKey)

  if (!target) {
    return appendHeadingSection(source, heading, block)
  }

  return appendAtHeading(source, headings, target, block)
}

function appendHeadingSection(source: string, heading: string, block: string): string {
  const base = source.replace(/\s*$/, '')
  const prefix = base.length > 0 ? `${base}\n\n` : ''
  return `${prefix}## ${heading.trim()}\n\n${block}\n`
}

function appendAtHeading(
  source: string,
  headings: Heading[],
  target: Heading,
  block: string,
): string {
  const sectionEnd = nextSectionStart(headings, target, source.length)
  const head = source.slice(0, sectionEnd).replace(/\s*$/, '')
  const tail = source.slice(sectionEnd)
  const inserted = `${head}\n\n${block}`
  return tail ? `${inserted}\n\n${tail}` : `${inserted}\n`
}

/** The target when a heading consists entirely of one parsed wiki link. */
function linkedHeadingTarget(
  source: string,
  heading: Heading,
  wikiLinks: readonly WikiLink[],
): string | null {
  const raw = source.slice(heading.from, heading.to)
  const firstLine = raw.slice(0, raw.indexOf('\n') === -1 ? raw.length : raw.indexOf('\n'))
  const content = firstLine
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '')
    .replace(/[ \t]+#+[ \t]*$/, '')
    .trim()
  const match = /^\[\[\s*([^\]|\r\n]+?)\s*(?:\|[^\]\r\n]*)?\]\]$/.exec(content)
  const textTarget = match?.[1]?.trim()
  if (textTarget === undefined || textTarget === '') {
    return null
  }
  const parsedLink = wikiLinks.find(
    (link) =>
      link.from >= heading.from &&
      link.to <= heading.to &&
      foldKey(link.target) === foldKey(textTarget),
  )
  return parsedLink?.target ?? null
}

/**
 * Whether `heading` names `title` either as a linked heading (`## [[Links]]`)
 * or as the legacy plain form (`## Links`). A linked heading's target, rather
 * than its display alias, identifies the section.
 */
export function headingMatchesBacklinkedTitle(
  source: string,
  heading: Heading,
  wikiLinks: readonly WikiLink[],
  title: string,
): boolean {
  return foldKey(linkedHeadingTarget(source, heading, wikiLinks) ?? heading.text) === foldKey(title)
}

function matchingBacklinkedHeading(
  source: string,
  headings: readonly Heading[],
  wikiLinks: readonly WikiLink[],
  titles: readonly string[],
): Heading | undefined {
  const matches = headings.filter((heading) =>
    heading.level === 2 &&
    titles.some((title) => headingMatchesBacklinkedTitle(source, heading, wikiLinks, title)),
  )
  return (
    matches.find((heading) => linkedHeadingTarget(source, heading, wikiLinks) !== null) ?? matches[0]
  )
}

/**
 * Add the missing wiki link to an existing legacy `## Title` section heading.
 * Missing or already-linked sections are byte-identical no-ops.
 */
export function upgradeSectionHeadingBacklink(
  source: string,
  title: string,
  matchingTitles: readonly string[] = [],
): string {
  const safeTitle = wikiLinkSafe(title)
  if (safeTitle === '') {
    throw new Error('a backlinked heading needs a title')
  }
  const { headings, wikiLinks } = parseNote({ path: '', source })
  const target = matchingBacklinkedHeading(source, headings, wikiLinks, [safeTitle, ...matchingTitles])
  if (target === undefined || linkedHeadingTarget(source, target, wikiLinks) !== null) {
    return source
  }
  return (
    source.slice(0, target.from) +
    `${'#'.repeat(target.level)} [[${safeTitle}]]` +
    source.slice(target.to)
  )
}

/**
 * Append `block` under a section whose heading is itself a wiki link. New
 * sections are emitted as `## [[Title]]`; an existing linked heading is reused,
 * including an aliased display spelling. The old app-generated `## Title` form
 * is upgraded in place so the next automatic append adds the missing backlink
 * without splitting one category across duplicate sections.
 */
export function appendUnderBacklinkedHeading(
  source: string,
  title: string,
  block: string,
  matchingTitles: readonly string[] = [],
): string {
  const safeTitle = wikiLinkSafe(title)
  if (safeTitle === '') {
    throw new Error('a backlinked heading needs a title')
  }
  const linkedHeading = `[[${safeTitle}]]`
  const upgraded = upgradeSectionHeadingBacklink(source, safeTitle, matchingTitles)
  const { headings, wikiLinks } = parseNote({ path: '', source: upgraded })
  const target = matchingBacklinkedHeading(
    upgraded,
    headings,
    wikiLinks,
    [safeTitle, ...matchingTitles],
  )

  if (target === undefined) {
    return appendHeadingSection(upgraded, linkedHeading, block)
  }
  return appendAtHeading(upgraded, headings, target, block)
}
