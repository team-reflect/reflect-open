import {
  parseMarkdownAst,
  type MarkdownBlock,
  type MarkdownDocument,
  type MarkdownListItem,
  type MarkdownNode,
} from '@meowdown/markdown'
import { NoteEditError } from '../tasks/task-errors.ts'
import {
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
import { hasSameTaskContent, type TaskLocator, type TaskSnapshot } from './task-model.ts'
import { compareTaskPaths, isSameTaskPath } from './task-path.ts'
import { getRoundTasks, toTaskSnapshot, type TaskEntry } from './task-project.ts'

export type InsertPosition =
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
  /** The new task is written checked. */
  checked?: boolean | undefined
  /** The text is written as a plain bullet, which `inserted` leaves out. */
  bullet?: boolean | undefined
}

export type TaskEdit = TaskEditItem | TaskEditInsert

/** One pre-edit round task and where the edit left it: null once removed or no longer a task. */
export interface TaskMove {
  from: TaskSnapshot
  to: TaskSnapshot | null
}

export interface TaskEditResult {
  source: string
  /** The hash of the source the edits were applied to, when the caller knew it. */
  baseRevision: string | null
  /** Every pre-edit round task, in document order. */
  moved: readonly TaskMove[]
  /** The inserted tasks, in edit order. */
  inserted: readonly TaskSnapshot[]
  /** The round tasks of the new source, in document order. */
  tasks: readonly TaskSnapshot[]
}

/**
 * Apply `edits` to a note and serialize its body once. `revision` is the hash
 * of `source`, or `null` when no file holds that text. Every locator describes
 * the note as the caller last saw it: all locators are resolved against the
 * pre-edit tree before anything changes, so one batch can edit a task and then
 * toggle it, or resolve a task and insert next to it, with one locator each.
 * Inserts that share a place land in the order of `edits`.
 */
export function applyTaskEdits(
  source: string,
  revision: string | null,
  edits: readonly TaskEdit[],
): TaskEditResult {
  const { document, bodyOffset } = parseEditable(source)
  const baseRevision = revision

  const before = getRoundTasks(document)
  const created: MarkdownListItem[] = []
  // The item this batch inserted after each block.
  const tails = new Map<MarkdownBlock, MarkdownListItem>()
  // Resolve every locator first, then mutate in order.
  const mutations = edits.map((edit): (() => void) => {
    if (edit.kind === 'insert') {
      const { at } = edit
      const contextSlot =
        at.kind === 'contextEnd' ? resolveContextEnd(before, baseRevision, at.task) : null
      const markdown = requireParagraphMarkdown(edit.markdown)
      const bullet = edit.bullet === true
      const item = createListItem(bullet ? 'bullet' : 'task', '+', markdown)
      item.checked = !bullet && edit.checked === true
      return () => {
        let slot = contextSlot ?? sectionSlot(document, TASKS_SECTION, 'task')
        while (slot.kind === 'after') {
          const tail = tails.get(slot.anchor)
          if (tail === undefined) {
            break
          }
          slot = { kind: 'after', anchor: tail }
        }
        const inserted = insertItem(document, slot, item)
        if (slot.kind === 'after') {
          tails.set(slot.anchor, inserted)
        }
        if (!bullet) {
          created.push(inserted)
        }
      }
    }
    const { node } = locateTask(before, baseRevision, edit.task)
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
      throw new NoteEditError('invalidContent', 'the new task did not survive the edit')
    }
    return snapshot
  })

  const nextBody = serializeBody(document)
  assertTasksSurvive(nextBody, after)
  const nextSource = source.slice(0, bodyOffset) + nextBody
  return {
    source: nextSource,
    baseRevision,
    moved,
    inserted,
    tasks: after.map(toTaskSnapshot),
  }
}

/**
 * The entry a locator names, among `before` in document order. A locator
 * read at `revision`, the hash of the text the entries come from, names the
 * entry at its path. Any other locator names the entry at its path when that
 * entry has its content, else the entry with its content that is nearest to
 * its path in document order, the earlier one of two equally near.
 */
function locateTask(
  before: readonly TaskEntry[],
  revision: string | null,
  locator: TaskLocator,
): TaskEntry {
  const atPath = before.find((entry) => isSameTaskPath(entry.astPath, locator.astPath))
  if (
    atPath !== undefined &&
    (locator.revision === revision || hasSameTaskContent(atPath, locator))
  ) {
    return atPath
  }
  const position = before.filter((entry) => {
    return compareTaskPaths(entry.astPath, locator.astPath) < 0
  }).length
  let nearest: TaskEntry | undefined
  let nearestDistance = Infinity
  if (locator.revision !== revision) {
    for (const [i, entry] of before.entries()) {
      const distance = Math.abs(i - position)
      if (distance < nearestDistance && hasSameTaskContent(entry, locator)) {
        nearest = entry
        nearestDistance = distance
      }
    }
  }
  if (nearest === undefined) {
    throw new NoteEditError(
      'stale',
      `task is no longer in the note: ${JSON.stringify(locator.markdown)}`,
    )
  }
  return nearest
}

/**
 * The end of the context of the task `locator` names: its parent list item,
 * or at the root the end of its own list.
 */
function resolveContextEnd(
  before: readonly TaskEntry[],
  revision: string | null,
  locator: TaskLocator,
): SlotTarget {
  const { parent, index } = locateTask(before, revision, locator)
  if (parent.type === 'listItem') {
    return { kind: 'end', container: parent }
  }
  return { kind: 'after', anchor: parent.children[endOfListRun(parent.children, index)]! }
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
      'invalidContent',
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
        hasSameTaskContent(entry, wanted)
      )
    })
  if (!survives) {
    throw new NoteEditError(
      'invalidContent',
      'This text cannot be saved as one task. Remove the line that starts a new block and try again.',
    )
  }
}
