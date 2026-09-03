import type { ReactElement, ReactNode } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBridgedNoteToggle } from '@/lib/notes/use-bridged-note-toggle'
import { cn } from '@/lib/utils'

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
  /** Optional side-effect for surfaces that also expose this flag elsewhere. */
  applyOptimistic?: (active: boolean) => void
  /** Optional reconciliation for optimistic side effects after a failed write. */
  onFailure?: () => void
}

/**
 * One note-scoped frontmatter-flag toggle as an action-sidebar button — the
 * shared shape behind pin/unpin and private/un-private. The button reflects
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
  applyOptimistic,
  onFailure,
}: NoteToggleActionProps): ReactElement {
  const { isActive, isToggling, toggleActive } = useBridgedNoteToggle({
    path,
    indexActive,
    toggle,
    failureLabel,
    applyOptimistic,
    onFailure,
  })

  const button = (
    <button
      type="button"
      onClick={() => void toggleActive()}
      disabled={isToggling}
      className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start hover:bg-surface-hover disabled:opacity-50"
    >
      <span
        className={cn(
          'flex h-5 w-5 flex-none items-center justify-center',
          isActive ? 'text-accent' : 'text-text-muted group-hover:text-text',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {isActive ? labels.active : labels.inactive}
      </span>
      {keybinding !== null ? (
        <ShortcutKeys binding={keybinding} className="invisible group-hover:visible" />
      ) : null}
    </button>
  )

  if (!tooltip) {
    return button
  }

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
