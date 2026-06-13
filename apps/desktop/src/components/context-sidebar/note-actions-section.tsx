import type { ReactElement } from 'react'
import { Lock } from 'lucide-react'
import { PinIcon } from '@/components/icons/pin-icon'
import { useNoteRow } from '@/hooks/use-note-row'
import { usePinnedNotes } from '@/hooks/use-pinned-notes'
import { keybindingFor } from '@/lib/commands/app-commands'
import { toggleNotePinned } from '@/lib/note-pin'
import { toggleNotePrivate } from '@/lib/note-private'
import { NoteGistAction } from './note-gist-action'
import { NoteToggleAction } from './note-toggle-action'
import { SidebarSection } from './sidebar-section'

interface NoteActionsSectionProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
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
 * Each action reflects the index's state (the pin from the same query as the
 * sidebar's Pinned section, privacy from the note's own row), bridged by the
 * last toggle's result while the watcher catches up.
 */
export function NoteActionsSection({ path }: NoteActionsSectionProps): ReactElement {
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const isPrivate = useNoteRow(path)?.isPrivate ?? false

  return (
    <SidebarSection storageKey="note-actions" title="Note actions">
      <NoteToggleAction
        path={path}
        indexActive={isPinned}
        toggle={toggleNotePinned}
        icon={<PinIcon width={20} height={20} />}
        labels={{ active: 'Un-pin this note', inactive: 'Pin this note' }}
        operations={{ activate: 'Pinning note', deactivate: 'Unpinning note' }}
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
        operations={{
          activate: 'Locking note',
          deactivate: 'Unlocking note',
        }}
        keybinding={PRIVATE_KEYBINDING}
        tooltip="Private notes are never sent to AI or any other external service"
      />
      <NoteGistAction path={path} keybinding={GIST_KEYBINDING} />
    </SidebarSection>
  )
}
