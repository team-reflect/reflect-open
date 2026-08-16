import { useState } from 'react'
import { errorMessage } from '@reflect/core'
import { startOperation } from '@/lib/operations'
import { useGraph } from '@/providers/graph-provider'

export interface UseBridgedNoteToggleOptions {
  /** Graph-relative path of the note whose frontmatter flag is toggled. */
  readonly path: string
  /** The flag's state per the index, before any local bridge is applied. */
  readonly indexActive: boolean
  /** Flip the flag in frontmatter and resolve to the note's new state. */
  readonly toggle: (path: string, generation: number) => Promise<boolean>
  /** Operation label for surfaced write failures. */
  readonly failureLabel: string | ((active: boolean) => string)
  /** Optional side-effect for surfaces that mirror the same state elsewhere. */
  readonly applyOptimistic?: ((active: boolean) => void) | undefined
  /** Optional reconciliation after a failed optimistic side-effect. */
  readonly onFailure?: (() => void) | undefined
}

export interface BridgedNoteToggle {
  /** The action state after bridging any just-written result over the index. */
  readonly isActive: boolean
  /** True while a toggle write is in flight. */
  readonly isToggling: boolean
  /** Toggle the flag through the canonical frontmatter write path. */
  readonly toggleActive: () => Promise<void>
}

interface PendingToggle {
  readonly path: string
  readonly active: boolean
}

function resolvedFailureLabel(
  failureLabel: UseBridgedNoteToggleOptions['failureLabel'],
  active: boolean,
): string {
  return typeof failureLabel === 'function' ? failureLabel(active) : failureLabel
}

/**
 * Bridge one note-frontmatter toggle over the lagging index until the watcher
 * or local write echo catches up. The toggle result is fresher than the index,
 * so holding it locally prevents a stale second tap from silently undoing the
 * user's action.
 */
export function useBridgedNoteToggle({
  path,
  indexActive,
  toggle,
  failureLabel,
  applyOptimistic,
  onFailure,
}: UseBridgedNoteToggleOptions): BridgedNoteToggle {
  const { graph } = useGraph()
  const [isToggling, setIsToggling] = useState(false)
  const [pending, setPending] = useState<PendingToggle | null>(null)

  if (pending !== null && (pending.path !== path || pending.active === indexActive)) {
    setPending(null)
  }

  const isActive = pending !== null && pending.path === path ? pending.active : indexActive

  const toggleActive = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined || isToggling) {
      return
    }

    const activeBeforeToggle = isActive
    const optimisticActive = !activeBeforeToggle
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
      startOperation(resolvedFailureLabel(failureLabel, activeBeforeToggle)).fail(
        errorMessage(cause),
      )
    } finally {
      setIsToggling(false)
    }
  }

  return { isActive, isToggling, toggleActive }
}
