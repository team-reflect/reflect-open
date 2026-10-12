import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AtSign, Lock } from 'lucide-react'
import { PinIcon } from '@/components/icons/pin-icon.tsx'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { keybindingFor } from '@/lib/commands/app-commands.ts'
import { toggleNotePinned } from '@/lib/note-pin.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { toggleNotePrivate } from '@/lib/note-private.ts'
import { NoteActionButton } from './note-action-button.tsx'
import { NoteGistAction } from './note-gist-action.tsx'
import { NoteTrashAction } from './note-trash-action.tsx'
import { SidebarSection } from './sidebar-section.tsx'

interface NoteActionsSectionProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
  /** Whether this context can offer deleting the note. Daily sidebars leave this off. */
  showTrash?: boolean
  /** Reveal the Note aliases input. The action is offered only when this is given. */
  onAddAlias?: (() => void) | undefined
}

// Derived from the command definitions so the hints can never drift from the
// real bindings (the same contract as the Today hint).
const PIN_KEYBINDING = keybindingFor('note.togglePin')
const PRIVATE_KEYBINDING = keybindingFor('note.togglePrivate')
const GIST_KEYBINDING = keybindingFor('note.publishGist')

/**
 * "Note actions" as a context-sidebar section: mouse-reachable counterparts
 * to the note-scoped commands — pin/unpin and the `private` flag. Shared by
 * the daily and note context sidebars; dailies are valid targets for both.
 * Pin reads the shared shelf cache, updated immediately by every pin entrypoint.
 * Privacy reads the note row cache shared by the palette and mobile actions.
 */
export function NoteActionsSection({
  path,
  showTrash = false,
  onAddAlias,
}: NoteActionsSectionProps): ReactElement {
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const noteRow = useNoteRow(path)
  const isPrivate = noteRow?.isPrivate ?? false
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const togglePin = async (): Promise<void> => {
    if (graph !== null) {
      await toggleNotePinned({
        queryClient,
        root: graph.root,
        generation: graph.generation,
        path,
      })
    }
  }

  const togglePrivate = async (): Promise<void> => {
    if (graph !== null) {
      await toggleNotePrivate({ queryClient, root: graph.root, generation: graph.generation, path })
    }
  }

  return (
    <SidebarSection storageKey="note-actions" title="Note actions">
      <NoteActionButton
        isActive={isPinned}
        onClick={togglePin}
        icon={<PinIcon width={20} height={20} />}
        labels={{ active: 'Un-pin this note', inactive: 'Pin this note' }}
        keybinding={PIN_KEYBINDING}
      />
      <NoteActionButton
        isActive={isPrivate}
        onClick={togglePrivate}
        icon={<Lock size={14} aria-hidden />}
        labels={{
          active: 'Unlock note',
          inactive: 'Lock note',
        }}
        keybinding={PRIVATE_KEYBINDING}
        tooltip="Locks this note out of AI. Backup and sync still include it."
      />
      {onAddAlias ? (
        <NoteActionButton
          isActive={false}
          onClick={async () => onAddAlias()}
          icon={<AtSign size={14} aria-hidden />}
          labels={{ active: 'Add alias', inactive: 'Add alias' }}
          tooltip="Another name this note can be linked by"
        />
      ) : null}
      <NoteGistAction path={path} keybinding={GIST_KEYBINDING} />
      {showTrash ? <NoteTrashAction path={path} /> : null}
    </SidebarSection>
  )
}
