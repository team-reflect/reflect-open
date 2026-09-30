import type { ReactElement } from 'react'
import { MarkdownInlineView } from '@meowdown/react'
import type { Task } from '@reflect/core'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'

/** Render the first paragraph as inline Markdown. */
export function TaskText({ task }: { task: Task }): ReactElement {
  return (
    <MarkdownInlineView
      markdown={task.text}
      resolveWikilink={resolveWikilink}
      markMode="hide"
      interactive={false}
      className="reflect-editor reflect-task-preview pointer-events-none text-sm"
    />
  )
}
