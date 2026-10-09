import {
  isMarkdownAstEqual,
  parseMarkdownAst,
  serializeMarkdownAst,
  walkMarkdownAst,
  type MarkdownAstPath,
  type MarkdownBlock,
  type MarkdownBlockquote,
  type MarkdownDocument,
  type MarkdownListItem,
  type MarkdownNode,
  type MarkdownTableCell,
} from '@meowdown/markdown'
import { DefaultMap } from '@ocavue/utils'
import { splitFrontmatter } from './frontmatter.ts'
import { renderInlineText } from './inline-text.ts'
import { normalizeWikiTarget } from './resolve.ts'
import { scanInlineWikiLinks } from './scan.ts'
import { isSameTaskPath } from './task-path.ts'

/** The task a caller addressed is not in the note anymore: the write is refused. */
export class TaskStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskStaleError'
  }
}

/** The note cannot be rewritten through the AST without changing its content. */
export class NoteNotSerializableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoteNotSerializableError'
  }
}

type BlockParent = MarkdownDocument | MarkdownBlockquote | MarkdownListItem | MarkdownTableCell

function isBlockParent(node: MarkdownNode): node is BlockParent {
  return (
    node.type === 'document' ||
    node.type === 'blockquote' ||
    node.type === 'listItem' ||
    node.type === 'tableCell'
  )
}

/** A Reflect task: a round (`+`) checkbox item, wherever it sits in the body. */
export function isRoundTask(node: MarkdownNode): node is MarkdownListItem {
  return node.type === 'listItem' && node.kind === 'task' && node.marker === '+'
}

/**
 * The Markdown of an item's first paragraph: a task's text, or a parent's
 * breadcrumb label. Surrounding whitespace is not content and is dropped, so
 * a trailing-space line projects the same as a clean one.
 */
export function getFirstParagraphMarkdown(item: MarkdownListItem): string {
  const first = item.children[0]
  return first?.type === 'paragraph' ? first.value.trim() : ''
}

export interface TaskEntry extends TaskSnapshot {
  node: MarkdownListItem
  parent: BlockParent
  /** The item's index in `parent.children`, valid until the tree is edited. */
  index: number
}

/** One heading a document-level block sits under. */
interface Section {
  level: number
  label: string
}

/** The labels of the open sections, outermost first; an empty heading labels nothing. */
function sectionLabels(sections: readonly Section[]): string[] {
  return sections.map((section) => section.label).filter((label) => label !== '')
}

export function getRoundTasks(document: MarkdownDocument): TaskEntry[] {
  const breadcrumbsOf = new DefaultMap<MarkdownNode, readonly string[]>(() => [])
  const entries: TaskEntry[] = []
  // The headings above the current document-level block, like an outline.
  const sections: Section[] = []
  for (const { node, parent, path, index } of walkMarkdownAst(document)) {
    if (parent === undefined || index === undefined) {
      continue
    }
    if (parent === document && node.type === 'heading') {
      // A heading closes every section of its own level or deeper.
      while ((sections.at(-1)?.level ?? 0) >= node.level) {
        sections.pop()
      }
      sections.push({ level: node.level, label: node.value.trim() })
    }
    const inherited = parent === document ? sectionLabels(sections) : breadcrumbsOf.get(parent)
    const label = node.type === 'listItem' ? getFirstParagraphMarkdown(node) : ''
    breadcrumbsOf.set(node, label === '' ? inherited : [...inherited, label])
    if (isRoundTask(node) && isBlockParent(parent)) {
      entries.push({
        node,
        parent,
        index,
        astPath: path,
        markdown: label,
        breadcrumbs: inherited,
        checked: node.checked,
      })
    }
  }
  return entries
}

/** The first calendar-valid `[[YYYY-MM-DD]]` link in a task's Markdown, or null. */
export function getTaskDueDate(markdown: string): string | null {
  for (const link of scanInlineWikiLinks(markdown)) {
    const { date } = normalizeWikiTarget(link.target)
    if (date !== undefined) {
      return date
    }
  }
  return null
}

/** A round task as the projection stores it: its snapshot plus its explicit due date. */
export interface ParsedTask extends TaskSnapshot {
  dueDate: string | null
}

/** The round tasks of a note body, in document order. */
export function projectTasks(body: string): ParsedTask[] {
  return getRoundTasks(parseMarkdownAst(body)).map((entry) => ({
    ...toTaskSnapshot(entry),
    dueDate: getTaskDueDate(entry.markdown),
  }))
}

/** Where a task was last seen; `markdown` and `checked` are the staleness guard. */
export interface TaskLocator {
  astPath: MarkdownAstPath
  markdown: string
  checked: boolean
}

export type InsertPosition =
  | { kind: 'documentEnd' }
  /** The end of the task's context: its parent list item, or at the root the end of its own list. */
  | { kind: 'contextEnd'; task: TaskLocator }
  /** The end of the first `+` list in the top-level `## Tasks` section, created at the end when missing. */
  | { kind: 'tasksSection' }

/** An edit of one existing round task. */
export type TaskEditItem =
  | { kind: 'toggle'; task: TaskLocator }
  | { kind: 'setMarkdown'; task: TaskLocator; markdown: string }
  | { kind: 'remove'; task: TaskLocator }
  | { kind: 'toBullet'; task: TaskLocator }

export interface TaskEditInsert {
  kind: 'insert'
  at: InsertPosition
  markdown: string
}

export type TaskEdit = TaskEditItem | TaskEditInsert

/** A round task as it stands in a note body. */
export interface TaskSnapshot extends TaskLocator {
  /** The headings above the task, then its ancestor list items' first paragraphs, outermost first. */
  breadcrumbs: readonly string[]
}

/** One pre-edit round task and where the edit left it: null once removed or no longer a task. */
export interface TaskMove {
  from: TaskSnapshot
  to: TaskSnapshot | null
}

export interface TaskEditResult {
  source: string
  /** Every pre-edit round task, in document order. */
  moved: readonly TaskMove[]
  /** The inserted tasks, in edit order. */
  inserted: readonly TaskSnapshot[]
  /** The round tasks of the new source, in document order. */
  tasks: readonly TaskSnapshot[]
}

/**
 * Where a write left the task a locator names, or undefined when the locator
 * names none. Resolved like the edit itself, so a locator from a stale index
 * follows its task by content instead of claiming whatever task now sits at
 * its path.
 */
export function findTaskMove(moves: readonly TaskMove[], task: TaskLocator): TaskMove | undefined {
  return resolveTaskLocator(moves, (move) => move.from, task)
}

/** A slot for a new item: right after a block, or at the end of a container. */
type SlotTarget =
  | { kind: 'after'; anchor: MarkdownBlock }
  | { kind: 'end'; container: MarkdownDocument | MarkdownListItem }
  /** A new `## <heading>` section at the end of the document, holding the item. */
  | { kind: 'newSection'; heading: string }

/**
 * Apply `edits` to a note and serialize its body once. Every locator describes
 * the note as the caller last saw it: all addresses are resolved against the
 * pre-edit tree before anything changes, so one batch can edit a task and then
 * toggle it, or resolve a task and insert next to it, with one locator each.
 */
export function applyTaskEdits(source: string, edits: readonly TaskEdit[]): TaskEditResult {
  const { body, bodyOffset } = splitFrontmatter(source)
  const document = parseMarkdownAst(body)
  if (body === '') {
    document.children = []
  }
  assertSerializable(document)

  const before = getRoundTasks(document)
  const created: MarkdownListItem[] = []
  // Resolve every address first, then mutate in order.
  const mutations = edits.map((edit): (() => void) => {
    if (edit.kind === 'insert') {
      const slot = resolveInsertPosition(document, before, edit.at)
      const markdown = requireParagraphMarkdown(edit.markdown)
      return () => {
        created.push(insertTaskItem(document, slot, markdown))
      }
    }
    const { node } = locateTask(before, edit.task)
    return () => applyItemEdit(document, node, edit)
  })
  for (const mutate of mutations) {
    mutate()
  }

  const after = getRoundTasks(document)
  const snapshotOf = new Map<MarkdownNode, TaskSnapshot>(
    after.map((entry) => [entry.node, toTaskSnapshot(entry)] as const),
  )
  const moved = before.map((entry): TaskMove => ({
    from: toTaskSnapshot(entry),
    to: snapshotOf.get(entry.node) ?? null,
  }))
  const inserted = created.map((item) => {
    const snapshot = snapshotOf.get(item)
    if (snapshot === undefined) {
      throw new NoteNotSerializableError('the new task did not survive the edit')
    }
    return snapshot
  })

  const nextBody = document.children.length === 0 ? '' : serializeMarkdownAst(document)
  assertTasksSurvive(nextBody, after)
  return {
    source: source.slice(0, bodyOffset) + nextBody,
    moved,
    inserted,
    tasks: after.map(toTaskSnapshot),
  }
}

function toTaskSnapshot({ astPath, markdown, breadcrumbs, checked }: TaskEntry): TaskSnapshot {
  return { astPath, markdown, breadcrumbs, checked }
}

function assertSerializable(document: MarkdownDocument): void {
  if (document.children.length === 0) {
    return
  }
  const reparsed = parseMarkdownAst(serializeMarkdownAst(document))
  if (!isMarkdownAstEqual(reparsed, document)) {
    throw new NoteNotSerializableError(
      'This note cannot be rewritten faithfully. Edit the task in the note itself.',
    )
  }
}

function hasSameContent(entry: TaskLocator, locator: TaskLocator): boolean {
  return entry.checked === locator.checked && entry.markdown === locator.markdown
}

/**
 * The entry a locator names: the one at its path while its content still
 * matches, else the first entry with that content (the task moved). Several
 * entries with that content are identical lines, so the first is taken and
 * the guess is logged.
 */
function resolveTaskLocator<T>(
  entries: readonly T[],
  locatorOf: (entry: T) => TaskLocator,
  locator: TaskLocator,
): T | undefined {
  const atPath = entries.find((entry) => {
    const candidate = locatorOf(entry)
    return isSameTaskPath(candidate.astPath, locator.astPath) && hasSameContent(candidate, locator)
  })
  if (atPath !== undefined) {
    return atPath
  }
  const byContent = entries.filter((entry) => hasSameContent(locatorOf(entry), locator))
  if (byContent.length > 1) {
    console.warn(
      `task is ambiguous, taking the first of ${byContent.length}: ${JSON.stringify(locator.markdown)}`,
    )
  }
  return byContent[0]
}

function locateTask(before: readonly TaskEntry[], locator: TaskLocator): TaskEntry {
  const match = resolveTaskLocator(before, (entry) => entry, locator)
  if (match === undefined) {
    throw new TaskStaleError(`task is no longer in the note: ${JSON.stringify(locator.markdown)}`)
  }
  return match
}

function resolveInsertPosition(
  document: MarkdownDocument,
  before: readonly TaskEntry[],
  at: InsertPosition,
): SlotTarget {
  switch (at.kind) {
    case 'documentEnd': {
      return { kind: 'end', container: document }
    }
    case 'contextEnd': {
      const { parent, index } = locateTask(before, at.task)
      if (parent.type === 'listItem') {
        return { kind: 'end', container: parent }
      }
      return { kind: 'after', anchor: parent.children[endOfListRun(parent.children, index)]! }
    }
    case 'tasksSection': {
      const { children } = document
      const heading = findTasksHeading(children)
      if (heading === undefined) {
        return { kind: 'newSection', heading: 'Tasks' }
      }
      const list = findSectionTaskList(children, heading)
      return {
        kind: 'after',
        anchor: children[list === undefined ? heading : endOfListRun(children, list)]!,
      }
    }
  }
}

/** The character an item is written with; meowdown leaves it unset on a folded bullet, which it writes as `+`. */
function markerOf(item: MarkdownListItem): string | undefined {
  return item.marker ?? (item.kind === 'bullet' && item.collapsed ? '+' : undefined)
}

/** The index of the last item of the list that starts at `children[start]`: same marker, nothing else between. */
function endOfListRun(children: readonly MarkdownBlock[], start: number): number {
  const first = children[start]
  const marker = first?.type === 'listItem' ? markerOf(first) : undefined
  let end = start
  for (let i = start + 1; i < children.length; i++) {
    const block = children[i]
    if (block?.type !== 'listItem' || markerOf(block) !== marker) {
      break
    }
    end = i
  }
  return end
}

/** The index of the first top-level H1 or H2 that reads "Tasks" once its inline Markdown is rendered. */
function findTasksHeading(children: readonly MarkdownBlock[]): number | undefined {
  const index = children.findIndex(
    (block) =>
      block.type === 'heading' &&
      block.level <= 2 &&
      renderInlineText(block.value).trim().toLowerCase() === 'tasks',
  )
  return index === -1 ? undefined : index
}

/**
 * The index of the first `+` list item between the heading at `heading` and
 * the next heading of any level, or undefined when the section has none. A
 * list with another marker is skipped, so a `- [ ]` checklist in the section
 * never receives a round task.
 */
function findSectionTaskList(
  children: readonly MarkdownBlock[],
  heading: number,
): number | undefined {
  for (let i = heading + 1; i < children.length; i++) {
    const block = children[i]
    if (block?.type === 'heading') {
      return undefined
    }
    if (block?.type === 'listItem' && markerOf(block) === '+') {
      return i
    }
  }
  return undefined
}

/**
 * Parents and indexes are looked up when the edit is applied, not when it was
 * resolved: an earlier edit in the batch may have shifted the siblings or
 * lifted the node out of a removed parent.
 */
function insertTaskItem(
  document: MarkdownDocument,
  slot: SlotTarget,
  markdown: string,
): MarkdownListItem {
  const item = createTaskItem(markdown)
  if (slot.kind === 'after') {
    const { parent, index } = requireAttached(document, slot.anchor)
    parent.children.splice(index + 1, 0, item)
  } else if (slot.kind === 'newSection') {
    document.children.push({ type: 'heading', level: 2, value: slot.heading }, item)
  } else {
    if (slot.container.type === 'listItem') {
      requireAttached(document, slot.container)
    }
    slot.container.children.push(item)
  }
  return item
}

function applyItemEdit(
  document: MarkdownDocument,
  node: MarkdownListItem,
  edit: TaskEditItem,
): void {
  const { parent, index } = requireAttached(document, node)
  switch (edit.kind) {
    case 'toggle': {
      node.checked = !node.checked
      if (!node.checked) {
        delete node.taskMarker
      }
      break
    }
    case 'setMarkdown': {
      setFirstParagraph(node, requireParagraphMarkdown(edit.markdown))
      break
    }
    case 'remove': {
      parent.children.splice(index, 1, ...node.children.slice(1))
      break
    }
    case 'toBullet': {
      node.kind = 'bullet'
      node.checked = false
      node.collapsed = true
      delete node.taskMarker
      break
    }
  }
}

interface Attachment {
  parent: BlockParent
  index: number
}

/** Where `target` currently sits in the tree, or a stale error once an earlier edit detached it. */
function requireAttached(document: MarkdownDocument, target: MarkdownBlock): Attachment {
  for (const { node, parent } of walkMarkdownAst(document)) {
    if (node === target && parent !== undefined && isBlockParent(parent)) {
      return { parent, index: parent.children.indexOf(target) }
    }
  }
  throw new TaskStaleError('the task was removed earlier in this batch')
}

function requireParagraphMarkdown(markdown: string): string {
  const trimmed = markdown.trim()
  if (/\n[ \t]*\n/.test(trimmed)) {
    throw new TaskStaleError(`task content must be one paragraph: ${JSON.stringify(markdown)}`)
  }
  return trimmed
}

function setFirstParagraph(item: MarkdownListItem, markdown: string): void {
  const first = item.children[0]
  if (first?.type === 'paragraph') {
    first.value = markdown
  } else {
    item.children.unshift({ type: 'paragraph', value: markdown })
  }
}

function createTaskItem(markdown: string): MarkdownListItem {
  return {
    type: 'listItem',
    kind: 'task',
    marker: '+',
    checked: false,
    collapsed: false,
    children: [{ type: 'paragraph', value: markdown }],
  }
}

/** The written bytes must read back with the same tasks at the same paths. */
function assertTasksSurvive(body: string, expected: readonly TaskEntry[]): void {
  const actual = getRoundTasks(parseMarkdownAst(body))
  const survives =
    actual.length === expected.length &&
    actual.every((entry, i) => {
      const wanted = expected[i]
      return (
        wanted !== undefined &&
        isSameTaskPath(entry.astPath, wanted.astPath) &&
        hasSameContent(entry, wanted)
      )
    })
  if (!survives) {
    throw new NoteNotSerializableError(
      'This text cannot be saved as one task. Remove the line that starts a new block and try again.',
    )
  }
}
