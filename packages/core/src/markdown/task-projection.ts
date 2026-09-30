import {
  parseMarkdownAst,
  walkMarkdownAst,
  type MarkdownNode,
  type MarkdownDocument,
} from '@meowdown/markdown'
import type { ParsedTask } from './model.ts'
import { inlineMarkdownToDisplayText } from './plain-text.ts'
import { taskDueDate } from './task-due-date.ts'

/** The first paragraph of a task list item, or undefined for any other node. */
export function getTaskParagraph(node: MarkdownNode) {
  if (node.type !== 'listItem' || node.kind !== 'task') return
  const paragraph = node.children[0]
  return paragraph?.type === 'paragraph' ? paragraph : undefined
}

/** The round (`+ [ ]`) tasks outside quotes in a note body. */
export function projectTasks(body: string): ParsedTask[] {
  return projectTaskDocument(parseMarkdownAst(body))
}

/**
 * The tasks of a parsed document. By default only round tasks outside quotes,
 * which is what the Tasks view shows; `includeAll` also returns square and
 * quoted checkboxes, which backlinks can toggle.
 */
export function projectTaskDocument(document: MarkdownDocument, includeAll = false): ParsedTask[] {
  const contexts = new Map<MarkdownNode, { quoted: boolean; breadcrumbs: readonly string[] }>()
  const tasks: ParsedTask[] = []
  for (const { node, parent, path } of walkMarkdownAst(document)) {
    const context = parent && contexts.get(parent)
    const quoted = node.type === 'blockquote' || context?.quoted === true
    const breadcrumbs = context?.breadcrumbs ?? []
    if (node.type !== 'listItem') {
      contexts.set(node, { quoted, breadcrumbs })
      continue
    }
    const paragraph = getTaskParagraph(node)
    if (paragraph && (includeAll || (!quoted && node.marker === '+'))) {
      tasks.push({
        astPath: path,
        text: paragraph.value,
        checked: node.checked,
        dueDate: taskDueDate(paragraph.value),
        breadcrumbs,
      })
    }
    const first = node.children[0]
    const label = first?.type === 'paragraph' ? inlineMarkdownToDisplayText(first.value) : ''
    contexts.set(node, { quoted, breadcrumbs: label ? [...breadcrumbs, label] : breadcrumbs })
  }
  return tasks
}
