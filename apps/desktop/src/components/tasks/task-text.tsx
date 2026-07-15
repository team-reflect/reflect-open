import type { ReactElement } from 'react'
import type { OpenTask } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview'
import { useAssetPersistence } from '@/editor/use-asset-persistence'
import { taskContent } from '@/lib/tasks/task-content'
import { useGraph } from '@/providers/graph-provider'

/**
 * Render a task's content (its source line minus the checkbox marker) through
 * Reflect's read-only markdown preview. The focused row swaps this for the
 * inline editor; unfocused rows should look like rendered markdown, not raw
 * source text.
 */
export function TaskText({ task }: { task: OpenTask }): ReactElement {
  const { graph } = useGraph()
  const {
    resolveImageUrl,
    resolveFileLink,
    resolveWikiEmbed,
    resolveFileInfo,
    attachmentCatalogRevision,
  } = useAssetPersistence(graph?.generation ?? null, task.notePath)
  return (
    <MarkdownPreview
      content={taskContent(task.raw)}
      resolveImageUrl={resolveImageUrl}
      resolveFileLink={resolveFileLink}
      resolveWikiEmbed={resolveWikiEmbed}
      resolveFileInfo={resolveFileInfo}
      resolverRevision={attachmentCatalogRevision}
      interactive={false}
      className="reflect-task-preview pointer-events-none text-sm leading-6"
    />
  )
}
