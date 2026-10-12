import { useState, type ReactElement } from 'react'
import { NoteActionsSection } from './note-actions-section.tsx'
import { NoteAliasesSection } from './note-aliases-section.tsx'
import { PublishedUrlSection } from './published-url-section.tsx'
import { SimilarNotesSection } from './similar-notes-section.tsx'

interface NoteContextSidebarProps {
  /** Graph-relative path of the open note the sidebar describes. */
  path: string
}

/**
 * An ordinary note's contextual sidebar: note actions, the note's aliases
 * (when it has any, or one is being added), then the note's semantic
 * neighbors — the only place similar notes appear. Inbound links live under
 * the note itself (the incoming-backlinks panel), not here.
 * Rendered in the AppShell's right region on `note` routes.
 */
export function NoteContextSidebar({ path }: NoteContextSidebarProps): ReactElement {
  // Keyed by path so navigating away closes a half-typed alias.
  const [addingAliasFor, setAddingAliasFor] = useState<string | null>(null)
  return (
    <div className="flex flex-col py-2 text-text">
      <div className="my-4 space-y-4 pb-4">
        <NoteActionsSection path={path} showTrash onAddAlias={() => setAddingAliasFor(path)} />
        <NoteAliasesSection
          path={path}
          isAdding={addingAliasFor === path}
          onAddingDone={() => setAddingAliasFor(null)}
        />
        <PublishedUrlSection path={path} />
        <SimilarNotesSection path={path} />
      </div>
    </div>
  )
}
