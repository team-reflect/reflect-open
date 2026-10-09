import type { ReactElement } from 'react'
import type { OpenTask } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'

/**
 * Render a task's Markdown (its first paragraph, marker excluded) through
 * Reflect's read-only markdown preview, as one paragraph: a task whose text
 * starts with `+ [ ] ` or `# ` shows that text, not a second checkbox or a
 * heading. The focused row swaps this for the inline editor; unfocused rows
 * should look like rendered markdown, not raw source text.
 */
export function TaskText({ task }: { task: OpenTask }): ReactElement {
  return (
    <MarkdownPreview
      content={task.markdown}
      singleParagraph
      className="reflect-task-preview pointer-events-none text-sm"
    />
  )
}
