import type { MarkdownAstPath } from '@meowdown/markdown'

/** Where a task was last seen; `markdown` and `checked` are the staleness guard. */
export interface TaskLocator {
  astPath: MarkdownAstPath
  markdown: string
  checked: boolean
}

/** A round task as it stands in a note body. */
export interface TaskSnapshot extends TaskLocator {
  /** The headings above the task, then its ancestor list items' first paragraphs, outermost first. */
  breadcrumbs: readonly string[]
}

/** A round task as the projection stores it: its snapshot plus its explicit due date. */
export interface ParsedTask extends TaskSnapshot {
  // FIXME: what's the format of this string? YYYY-MM-DD? Add a super simple comment right above the "dueDate: string | null" line
  dueDate: string | null
}
