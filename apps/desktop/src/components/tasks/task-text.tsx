import type { ReactElement } from 'react'
import type { OpenTask } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview'
import { taskContent } from '@/lib/tasks/task-content'

/**
 * Render a task's content (its source line minus the checkbox marker) through
 * Reflect's read-only markdown preview. The focused row swaps this for the
 * inline editor; unfocused rows should look like rendered markdown, not raw
 * source text.
 */
export function TaskText({ task }: { task: OpenTask }): ReactElement {
  return (
    <MarkdownPreview
      content={taskContent(task.raw)}
      className="reflect-task-preview pointer-events-none text-sm leading-6"
    />
  )
}
