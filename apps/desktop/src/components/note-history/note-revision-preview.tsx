import type { ReactElement } from 'react'
import { errorMessage, splitFrontmatter, type NoteRevision } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { useNoteRevisionText } from '@/hooks/use-note-history.ts'

interface NoteRevisionPreviewProps {
  revision: NoteRevision
}

/** The selected revision rendered read-only, as the note looked then. */
export function NoteRevisionPreview({ revision }: NoteRevisionPreviewProps): ReactElement {
  const { text, error } = useNoteRevisionText(revision)

  if (error !== null) {
    return <InlineAlert tone="error">{errorMessage(error)}</InlineAlert>
  }
  if (text === undefined) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="size-4 text-text-muted" />
      </div>
    )
  }
  return (
    <MarkdownPreview
      content={splitFrontmatter(text).body}
      sourcePath={revision.path}
      interactive={false}
    />
  )
}
