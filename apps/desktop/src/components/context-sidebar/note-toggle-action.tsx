import type { ReactElement, ReactNode } from 'react'
import { useBridgedNoteToggle } from '@/lib/notes/use-bridged-note-toggle'
import { NoteActionButton } from './note-action-button'

interface NoteToggleActionProps {
  /** Graph-relative path of the note the action operates on. */
  path: string
  /** The flag's state per the index (lags a write by one watcher round-trip). */
  indexActive: boolean
  /** Flip the flag in the note's frontmatter; resolves to the new state. */
  toggle: (path: string, generation: number) => Promise<boolean>
  /** Icon left of the label; accent-tinted while the flag is on. */
  icon: ReactNode
  /** Button label for each flag state (the action offered, not the state). */
  labels: { active: string; inactive: string }
  /** Operation label used when the frontmatter write fails. */
  failureLabel: string
  /** Keybinding hint, from the matching command definition. */
  keybinding?: string | null
  /** Optional tooltip explaining the flag's meaning. */
  tooltip?: string
}

/**
 * One note-scoped frontmatter-flag toggle as an action-sidebar button. The button reflects
 * the index's state, bridged by the last toggle's result while the watcher
 * catches up; failures surface through the operations status line.
 */
export function NoteToggleAction({
  path,
  indexActive,
  toggle,
  icon,
  labels,
  failureLabel,
  keybinding = null,
  tooltip,
}: NoteToggleActionProps): ReactElement {
  const { isActive, isToggling, toggleActive } = useBridgedNoteToggle({
    path,
    indexActive,
    toggle,
    failureLabel,
  })

  return (
    <NoteActionButton
      isActive={isActive}
      disabled={isToggling}
      onClick={toggleActive}
      icon={icon}
      labels={labels}
      keybinding={keybinding}
      tooltip={tooltip}
    />
  )
}
