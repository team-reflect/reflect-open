import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { useNoteAttachments } from '@/editor/use-note-attachments.ts'
import { splitFrontmatter, formatDayLabel } from '@reflect/core'
import type { NoteEntry } from '@reflect/app'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The palette's live preview pane: the highlighted result's markdown, read
 * straight from disk and rendered read-only. Keyed under the index scope so an
 * edit that re-indexes while the palette is open refreshes the preview too.
 *
 * A missing file is not an error here — daily suggestions are valid jump
 * targets before their file exists (the lazy contract) — it previews as Empty.
 */

interface NotePreviewProps {
  /** The highlighted palette entry to preview. */
  entry: NoteEntry
}

export function NotePreview({ entry }: NotePreviewProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const { noteDocuments } = useCoreServices()
  const { resolveImageUrl, resolveWikiEmbed } = useNoteAttachments(entry.path)
  const { data, isError } = useQuery({
    queryKey: queryKeys.index.notePreview(graph?.root, entry.path),
    queryFn: () => noteDocuments.readSource(entry.path),
    enabled: graph !== null,
  })

  const body = data === null || data === undefined ? null : splitFrontmatter(data).body

  let content: ReactElement | null
  if (isError) {
    content = <p className="text-sm text-text-muted">This note can’t be previewed.</p>
  } else if (data === undefined) {
    content = null // still loading; blank beats a flash of the wrong state
  } else if (body === null || body.trim() === '') {
    content = <p className="text-sm text-text-muted italic">Empty</p>
  } else {
    content = (
      <MarkdownPreview
        content={body}
        // Note links stay inert, like the preview's wiki link chips.
        sourcePath={null}
        resolveImageUrl={resolveImageUrl}
        resolveWikiEmbed={resolveWikiEmbed}
      />
    )
  }

  return (
    <div data-testid="palette-preview" className="h-full px-5 py-4">
      {entry.date !== null ? (
        <h2 className="mb-3 text-lg font-semibold">
          {formatDayLabel(entry.date, settings.dateFormat)}
        </h2>
      ) : null}
      {content}
    </div>
  )
}
