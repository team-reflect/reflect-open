import type { MarkdownHeading } from '@meowdown/markdown'
import { renderInlineText } from './inline-text.ts'

/** Whether a label names the automatic Tasks section, ignoring case and surrounding space. */
export function isTasksLabel(label: string): boolean {
  return label.trim().toLowerCase() === 'tasks'
}

/**
 * A heading that reads "Tasks" once its inline Markdown is rendered: plain,
 * bold, code, or a wiki link such as `## [[Tasks]]`. An aliased link
 * (`## [[Tasks|To do]]`) reads as its alias and is an ordinary heading.
 */
export function isTasksHeading(heading: MarkdownHeading): boolean {
  return isTasksLabel(renderInlineText(heading.value))
}
