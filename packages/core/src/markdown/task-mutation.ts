import {
  parseMarkdownAst,
  resolveMarkdownAstPath,
  serializeMarkdownAst,
  walkMarkdownAst,
  type MarkdownListItem,
} from '@meowdown/markdown'
import { splitFrontmatter } from './frontmatter.ts'
import { getTaskParagraph, projectTaskDocument } from './task-projection.ts'
import { encodeTaskPath } from './task-path.ts'
import { protectTaskParagraph } from './task-paragraph.ts'

/** A list item to create: its paragraph text and marker. */
export interface NewTask {
  text: string
  checked?: boolean | undefined
  /** Create a plain `+` bullet instead of a checkbox. */
  bullet?: boolean | undefined
}

/** One structural change to a note's tasks. Paths are child indexes from the body's AST root. */
export type TaskOp =
  | { at: readonly number[]; text: string; checked: boolean; toBullet?: boolean | undefined }
  | { at: readonly number[]; remove: true }
  | { after: readonly number[] | null; create: NewTask }

function createItem(task: NewTask): MarkdownListItem {
  const item: MarkdownListItem = {
    type: 'listItem',
    kind: task.bullet ? 'bullet' : 'task',
    checked: task.bullet ? false : (task.checked ?? false),
    collapsed: task.bullet === true,
    marker: '+',
    children: [{ type: 'paragraph', value: task.text }],
  }
  protectTaskParagraph(item)
  return item
}

function taskItemAt(document: ReturnType<typeof parseMarkdownAst>, path: readonly number[]) {
  const entry = resolveMarkdownAstPath(document, path)
  const paragraph = entry && getTaskParagraph(entry.node)
  if (!entry || entry.node.type !== 'listItem' || !paragraph) {
    throw new Error('The task no longer exists. Refresh the task list.')
  }
  return { item: entry.node, paragraph }
}

/**
 * Apply one change to a note's tasks and serialize its entire body. Returns
 * the new source, a map from each surviving task's old AST path to its new
 * one, the created item's path, and every checkbox in the new source.
 */
export function editTaskDocument(source: string, op: TaskOp) {
  const { body, bodyOffset } = splitFrontmatter(source)
  const document = parseMarkdownAst(body)
  const originals = new Map<MarkdownListItem, readonly number[]>()
  for (const { node, path } of walkMarkdownAst(document)) {
    if (node.type === 'listItem' && getTaskParagraph(node)) originals.set(node, path)
  }
  let changed = false
  let edited: MarkdownListItem | undefined
  let created: MarkdownListItem | undefined
  if ('create' in op) {
    created = createItem(op.create)
    if (op.after === null) {
      if (body === '') document.children = []
      document.children.push(created)
    } else {
      const { item } = taskItemAt(document, op.after)
      const entry = [...walkMarkdownAst(document)].find((entry) => entry.node === item)!
      const parent = entry.parent
      if (!parent || parent.type === 'table' || parent.type === 'tableRow' || !parent.children) {
        throw new Error('The task cannot be continued here. Refresh the task list.')
      }
      parent.children.splice(entry.index! + 1, 0, created)
    }
    changed = true
  } else if ('remove' in op) {
    const { item } = taskItemAt(document, op.at)
    const entry = [...walkMarkdownAst(document)].find((entry) => entry.node === item)!
    const parent = entry.parent
    if (!parent || parent.type === 'table' || parent.type === 'tableRow' || !parent.children) {
      throw new Error('The task cannot be removed here. Refresh the task list.')
    }
    // Nested content survives as siblings in the task's place.
    parent.children.splice(entry.index!, 1, ...item.children.slice(1))
    changed = true
  } else {
    const { item, paragraph } = taskItemAt(document, op.at)
    if (paragraph.value !== op.text) {
      paragraph.value = op.text
      changed = true
    }
    if (item.checked !== op.checked) {
      item.checked = op.checked
      changed = true
    }
    if (op.toBullet) {
      item.kind = 'bullet'
      item.checked = false
      item.collapsed = true
      item.marker = '+'
      changed = true
    }
    protectTaskParagraph(item)
    edited = item
  }
  const nextSource = changed ? source.slice(0, bodyOffset) + serializeMarkdownAst(document) : source
  const reparsed = parseMarkdownAst(splitFrontmatter(nextSource).body)
  const mutatedPaths = new Map([...walkMarkdownAst(document)].map(({ node, path }) => [node, path]))
  // The edited paragraph must read back unchanged before the caller writes anything.
  if (edited) {
    const path = mutatedPaths.get(edited)
    const saved = path && resolveMarkdownAstPath(reparsed, path)?.node
    if (
      !saved ||
      saved.type !== 'listItem' ||
      saved.kind !== edited.kind ||
      saved.children[0]?.type !== 'paragraph' ||
      edited.children[0]?.type !== 'paragraph' ||
      saved.children[0].value !== edited.children[0].value
    ) {
      throw new Error('The edited task paragraph cannot be preserved. Refresh the task list.')
    }
  }
  const tasks = projectTaskDocument(reparsed, true)
  // Old paths map to new ones only when the serialized document reads back
  // with the task structure the in-memory mutation produced.
  const sameTasks = JSON.stringify(projectTaskDocument(document, true)) === JSON.stringify(tasks)
  const taskPaths = new Set(tasks.map((task) => encodeTaskPath(task.astPath)))
  const paths = new Map<string, readonly number[]>()
  let createdPath: readonly number[] | undefined
  if (sameTasks) {
    for (const [node, previous] of originals) {
      const path = mutatedPaths.get(node)
      if (path && taskPaths.has(encodeTaskPath(path))) paths.set(encodeTaskPath(previous), path)
    }
    createdPath = created && mutatedPaths.get(created)
  }
  if (created && !createdPath) throw new Error('The new task could not be preserved.')
  return { source: nextSource, paths, createdPath, tasks }
}
