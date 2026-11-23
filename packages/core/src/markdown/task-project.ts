import {
  parseMarkdownAst,
  walkMarkdownAst,
  type MarkdownBlockquote,
  type MarkdownDocument,
  type MarkdownListItem,
  type MarkdownNode,
  type MarkdownTableCell,
} from '@meowdown/markdown'
import { DefaultMap } from '@ocavue/utils'
import { renderInlineText } from './inline-text.ts'
import { normalizeWikiTarget } from './resolve.ts'
import { scanInlineWikiLinks } from './scan.ts'
import type { ParsedTask, TaskSnapshot } from './task-model.ts'

export type BlockParent =
  | MarkdownDocument
  | MarkdownBlockquote
  | MarkdownListItem
  | MarkdownTableCell

export function isBlockParent(node: MarkdownNode): node is BlockParent {
  return (
    node.type === 'document' ||
    node.type === 'blockquote' ||
    node.type === 'listItem' ||
    node.type === 'tableCell'
  )
}

/**
 * A Reflect task: a round (`+`) checkbox item, wherever it sits in the body.
 */
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
  /**
   * The item's index in `parent.children`, valid until the tree is edited.
   */
  index: number
}

/**
 * One heading a document-level block sits under.
 */
interface Section {
  level: number
  label: string
}

/**
 * The labels of the open sections, outermost first; an empty heading labels
 * nothing.
 */
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

/**
 * The first calendar-valid `[[YYYY-MM-DD]]` link in a task's Markdown, or null.
 */
export function getTaskDueDate(markdown: string): string | null {
  for (const link of scanInlineWikiLinks(markdown)) {
    const { date } = normalizeWikiTarget(link.target)
    if (date !== undefined) {
      return date
    }
  }
  return null
}

/**
 * The round tasks of a note body, in document order.
 */
export function projectTasks(body: string): ParsedTask[] {
  return getRoundTasks(parseMarkdownAst(body)).map((entry) => ({
    ...toTaskSnapshot(entry),
    dueDate: getTaskDueDate(entry.markdown),
  }))
}

/**
 * A task row's own fields: its snapshot plus what the view derives from the
 * Markdown.
 */
export interface TaskRow extends TaskSnapshot {
  /**
   * `markdown` rendered to plain text, for search and labels.
   */
  text: string
  /**
   * The headings above the task, then its ancestor list items' labels,
   * outermost first, rendered to plain text.
   */
  breadcrumbs: readonly string[]
  /**
   * The task's explicit `[[YYYY-MM-DD]]` due date, or null.
   */
  dueDate: string | null
}

/**
 * The row of a task snapshot: the snapshot with its display fields.
 */
export function renderTaskSnapshot(snapshot: TaskSnapshot): TaskRow {
  return {
    ...snapshot,
    text: renderInlineText(snapshot.markdown),
    breadcrumbs: snapshot.breadcrumbs.map((label) => renderInlineText(label)),
    dueDate: getTaskDueDate(snapshot.markdown),
  }
}

export function toTaskSnapshot({
  astPath,
  markdown,
  breadcrumbs,
  checked,
}: TaskEntry): TaskSnapshot {
  return { astPath, markdown, breadcrumbs, checked }
}
