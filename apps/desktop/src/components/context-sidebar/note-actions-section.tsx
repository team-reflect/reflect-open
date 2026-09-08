import type { ReactElement } from 'react'
import { Lock } from 'lucide-react'
import { PinIcon } from '@/components/icons/pin-icon'
import { useNoteRow } from '@/hooks/use-note-row'
import { keybindingFor } from '@/lib/commands/app-commands'
import { toggleNotePinned } from '@/lib/note-pin'
import { toggleNotePrivate } from '@/lib/note-private'
import { NoteGistAction } from './note-gist-action'
import { NoteTrashAction } from './note-trash-action'
import { NoteToggleAction } from './note-toggle-action'
import { SidebarSection } from './sidebar-section'

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
 * Each action reflects the note's index row, overlaid with whatever the last
 * toggle asserted while the watcher catches up.
 */
export function NoteActionsSection({
  path,
  showTrash = false,
}: NoteActionsSectionProps): ReactElement {
  const noteRow = useNoteRow(path)
  const isPinned = noteRow?.isPinned ?? false
  const isPrivate = noteRow?.isPrivate ?? false

  return (
    <SidebarSection storageKey="note-actions" title="Note actions">
      <NoteToggleAction
        path={path}
        indexActive={isPinned}
        toggle={toggleNotePinned}
        icon={<PinIcon width={20} height={20} />}
        labels={{ active: 'Un-pin this note', inactive: 'Pin this note' }}
        failureLabel="Updating pin"
        keybinding={PIN_KEYBINDING}
      />
      <NoteToggleAction
        path={path}
        indexActive={isPrivate}
        toggle={toggleNotePrivate}
        icon={<Lock size={14} aria-hidden />}
        labels={{
          active: 'Unlock note',
          inactive: 'Lock note',
        }}
        failureLabel="Updating privacy"
        keybinding={PRIVATE_KEYBINDING}
        tooltip="Locks this note out of AI. Backup and sync still include it."
      />
      <NoteGistAction path={path} keybinding={GIST_KEYBINDING} />
      {showTrash ? <NoteTrashAction path={path} /> : null}
    </SidebarSection>
  )
}
