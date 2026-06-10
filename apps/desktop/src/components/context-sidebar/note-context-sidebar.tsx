import type { ReactElement } from 'react'
import { BacklinksSection } from './backlinks-section'
import { SimilarNotesSection } from './similar-notes-section'

interface NoteContextSidebarProps {
  /** Graph-relative path of the open note the sidebar describes. */
  path: string
}

/**
 * An ordinary note's contextual sidebar (the old app's note context sidebar):
 * the note's inbound links and its semantic neighbors. Rendered in the
 * AppShell's right region on `note` routes; the note pane hides its inline
 * copies of these panels at the breakpoint where this sidebar appears, so the
 * context shows exactly once at every window size.
 */
export function NoteContextSidebar({ path }: NoteContextSidebarProps): ReactElement {
  return (
    <div className="flex flex-col px-2 py-2 text-text">
      <BacklinksSection path={path} emptyLabel="No notes link to this note yet." />
      <SimilarNotesSection path={path} />
    </div>
  )
}
