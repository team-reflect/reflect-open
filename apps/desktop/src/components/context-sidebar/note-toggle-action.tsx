import { useState, type ReactElement, type ReactNode } from 'react'
import { errorMessage } from '@reflect/core'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { startOperation } from '@/lib/operations'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'

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
 * The toggle's resolved state, held until the index reflects it. The label
 * otherwise lags one watcher round-trip behind the write, and in that window
 * a stale click would silently undo the user's toggle. The toggle reads the
 * note itself, so its return value is the freshest truth; the bridge retires
 * the moment the index agrees or the action moves to another note.
 */
interface PendingToggle {
  path: string
  active: boolean
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
  const { graph } = useGraph()
  // Guards against a double-click racing two read-patch-write toggles.
  const [isToggling, setIsToggling] = useState(false)
  const [pending, setPending] = useState<PendingToggle | null>(null)

  // Render-time state adjustment (the React-sanctioned pattern): drop the
  // bridge once the index agrees with it, so a later external flag change
  // can't resurrect a stale override.
  if (pending !== null && (pending.path !== path || pending.active === indexActive)) {
    setPending(null)
  }
  const isActive = pending !== null && pending.path === path ? pending.active : indexActive

  const onToggle = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined) {
      return
    }
    const optimisticActive = !isActive
    applyOptimistic?.(optimisticActive)
    setPending({ path, active: optimisticActive })
    setIsToggling(true)
    try {
      const active = await toggle(path, generation)
      if (active !== optimisticActive) {
        applyOptimistic?.(active)
      }
      setPending({ path, active })
    } catch (cause) {
      setPending(null)
      onFailure?.()
      startOperation(failureLabel).fail(errorMessage(cause))
    } finally {
      setIsToggling(false)
    }
  }

  const button = (
    <button
      type="button"
      onClick={() => void onToggle()}
      disabled={isToggling}
      className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start transition-colors duration-100 hover:bg-surface-hover disabled:opacity-50"
    >
      <span
        className={cn(
          'flex h-5 w-5 flex-none items-center justify-center transition-colors duration-100',
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
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
