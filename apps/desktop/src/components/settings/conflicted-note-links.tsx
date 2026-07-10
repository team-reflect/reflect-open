import type { ReactElement } from 'react'
import type { ConflictedNote } from '@reflect/core'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'

interface ConflictedNoteLinksProps {
  readonly notes: readonly ConflictedNote[]
}

interface ConflictedNoteLinkProps {
  readonly note: ConflictedNote
}

function ConflictedNoteLink({ note }: ConflictedNoteLinkProps): ReactElement {
  const navigateNoteLink = useNoteLinkNavigation(note.path)

  return (
    <li>
      <Button
        variant="ghost"
        size="sm"
        className="h-auto w-full max-w-sm justify-start whitespace-normal px-2 py-1 text-left text-xs text-current hover:bg-amber-500/10 hover:text-current"
        onClick={(event) => navigateNoteLink({ kind: 'note', path: note.path }, event)}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{note.title}</span>
          <span className="block truncate text-[11px] opacity-75">{note.path}</span>
        </span>
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 opacity-60"
          strokeWidth={1.75}
        />
      </Button>
    </li>
  )
}

/** Links from a sync warning directly to every note carrying conflict markers. */
export function ConflictedNoteLinks({ notes }: ConflictedNoteLinksProps): ReactElement | null {
  if (notes.length === 0) {
    return null
  }

  return (
    <ul className="mt-1 flex flex-col gap-0.5" aria-label="Notes that need review">
      {notes.map((note) => (
        <ConflictedNoteLink key={note.path} note={note} />
      ))}
    </ul>
  )
}
