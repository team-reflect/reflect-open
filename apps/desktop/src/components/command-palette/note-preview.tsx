import { type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isAppError, readNote, splitFrontmatter } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview'
import { useAssetPersistence } from '@/editor/use-asset-persistence'
import { formatDayLabel } from '@/lib/dates'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'
import type { NoteEntry } from './entries'

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

async function readNoteForPreview(path: string): Promise<string | null> {
  try {
    return await readNote(path)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return null
    }
    throw cause
  }
}

export function NotePreview({ entry }: NotePreviewProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const { resolveImageUrl } = useAssetPersistence(graph?.root ?? null, graph?.generation ?? null)
  const { data, isError } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'note-preview', entry.path],
    queryFn: () => readNoteForPreview(entry.path),
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
    content = <MarkdownPreview content={body} resolveImageUrl={resolveImageUrl} />
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
