import type { MarkdownHeading } from '@meowdown/markdown'
import { renderInlineText } from './inline-text.ts'

/**
 * A heading that reads "Tasks" once its inline Markdown is rendered: plain,
 * bold, code, or a wiki link such as `## [[Tasks]]`. An aliased link
 * (`## [[Tasks|To do]]`) reads as its alias and is an ordinary heading.
 */
export function isTasksHeading(heading: MarkdownHeading): boolean {
  return renderInlineText(heading.value).trim().toLowerCase() === 'tasks'
}
