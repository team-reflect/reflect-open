import {
  parseMarkdownAst,
  type MarkdownDocument,
  type MarkdownListItem,
  type MarkdownNode,
} from '@meowdown/markdown'
import type { LoggerService } from '../ports/logger-service.ts'
import { NoteEditError } from '../tasks/task-errors.ts'
import {
  bodyEndSlot,
  createListItem,
  endOfListRun,
  insertItem,
  parseEditable,
  requireAttached,
  sectionSlot,
  serializeBody,
  TASKS_SECTION,
  type SlotTarget,
} from './list-insert.ts'
import type { TaskLocator, TaskSnapshot } from './task-model.ts'
import { isSameTaskPath } from './task-path.ts'
import { getRoundTasks, toTaskSnapshot, type TaskEntry } from './task-project.ts'

/**
 * Where the task functions report a locator that names several identical tasks.
 */
export interface TaskLogContext {
  readonly logger: LoggerService
}

export type InsertPosition =
  | { kind: 'documentEnd' }
  /** The end of the task's context: its parent list item, or at the root the end of its own list. */
  | { kind: 'contextEnd'; task: TaskLocator }
  /** The end of the first `+` list in the top-level `## Tasks` section, created after the note's last content when missing. */
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
export function findTaskMove(
  ctx: TaskLogContext,
  moves: readonly TaskMove[],
  task: TaskLocator,
): TaskMove | undefined {
  return resolveTaskLocator(ctx, moves, (move) => move.from, task)
}

/**
 * Apply `edits` to a note and serialize its body once. Every locator describes
 * the note as the caller last saw it: all addresses are resolved against the
 * pre-edit tree before anything changes, so one batch can edit a task and then
 * toggle it, or resolve a task and insert next to it, with one locator each.
 */
export function applyTaskEdits(
  ctx: TaskLogContext,
  source: string,
  edits: readonly TaskEdit[],
): TaskEditResult {
  const { document, bodyOffset } = parseEditable(source)

  const before = getRoundTasks(document)
  const created: MarkdownListItem[] = []
  // Resolve every address first, then mutate in order.
  const mutations = edits.map((edit): (() => void) => {
    if (edit.kind === 'insert') {
      const slot = resolveInsertPosition(ctx, document, before, edit.at)
      const markdown = requireParagraphMarkdown(edit.markdown)
      return () => {
        created.push(insertItem(document, slot, createListItem('task', '+', markdown)))
      }
    }
    const { node } = locateTask(ctx, before, edit.task)
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
      throw new NoteEditError('notWritable', 'the new task did not survive the edit')
    }
    return snapshot
  })

  const nextBody = serializeBody(document)
  assertTasksSurvive(nextBody, after)
  return {
    source: source.slice(0, bodyOffset) + nextBody,
    moved,
    inserted,
    tasks: after.map(toTaskSnapshot),
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
  ctx: TaskLogContext,
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
    ctx.logger.warn(
      `task is ambiguous, taking the first of ${byContent.length}: ${JSON.stringify(locator.markdown)}`,
    )
  }
  return byContent[0]
}

function locateTask(
  ctx: TaskLogContext,
  before: readonly TaskEntry[],
  locator: TaskLocator,
): TaskEntry {
  const match = resolveTaskLocator(ctx, before, (entry) => entry, locator)
  if (match === undefined) {
    throw new NoteEditError(
      'stale',
      `task is no longer in the note: ${JSON.stringify(locator.markdown)}`,
    )
  }
  return match
}

function resolveInsertPosition(
  ctx: TaskLogContext,
  document: MarkdownDocument,
  before: readonly TaskEntry[],
  at: InsertPosition,
): SlotTarget {
  switch (at.kind) {
    case 'documentEnd': {
      return bodyEndSlot(document)
    }
    case 'contextEnd': {
      const { parent, index } = locateTask(ctx, before, at.task)
      if (parent.type === 'listItem') {
        return { kind: 'end', container: parent }
      }
      return { kind: 'after', anchor: parent.children[endOfListRun(parent.children, index)]! }
    }
    case 'tasksSection': {
      return sectionSlot(document, TASKS_SECTION, 'task')
    }
  }
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

function requireParagraphMarkdown(markdown: string): string {
  const trimmed = markdown.trim()
  if (/\n[ \t]*\n/.test(trimmed)) {
    throw new NoteEditError(
      'stale',
      `task content must be one paragraph: ${JSON.stringify(markdown)}`,
    )
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
    throw new NoteEditError(
      'notWritable',
      'This text cannot be saved as one task. Remove the line that starts a new block and try again.',
    )
  }
}
