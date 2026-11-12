import type { ReactElement } from 'react'
import { Lock } from 'lucide-react'
import { PinIcon } from '@/components/icons/pin-icon.tsx'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { keybindingFor } from '@/lib/commands/app-commands.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import { NoteActionButton } from './note-action-button.tsx'
import { NoteGistAction } from './note-gist-action.tsx'
import { NoteTrashAction } from './note-trash-action.tsx'
import { SidebarSection } from './sidebar-section.tsx'

interface NoteActionsSectionProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
  /** Whether this context can offer deleting the note. Daily sidebars leave this off. */
  showTrash?: boolean
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
 * Pin reads the pinned shelf and privacy reads the note row, both with the
 * note-row overlay every entrypoint writes merged over them.
 */
export function NoteActionsSection({
  path,
  showTrash = false,
}: NoteActionsSectionProps): ReactElement {
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const noteRow = useNoteRow(path)
  const isPrivate = noteRow?.isPrivate ?? false
  const { noteActions } = useCoreServices()
  const togglePin = async (): Promise<void> => {
    await noteActions.togglePinned(path)
  }

  const togglePrivate = async (): Promise<void> => {
    await noteActions.togglePrivate(path)
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
      <NoteGistAction path={path} keybinding={GIST_KEYBINDING} />
      {showTrash ? <NoteTrashAction path={path} /> : null}
    </SidebarSection>
  )
}
