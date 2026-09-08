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
 *
 * The *shared* optimism belongs to the write itself (`toggleNotePinned` and
 * `toggleNotePrivate` assert their result as a note-row overlay, so a keyboard
 * or palette flip moves every surface too). This hook keeps only what is local
 * to one button: its in-flight guard, and its own view of the flag.
 */
export function useBridgedNoteToggle({
  path,
  indexActive,
  toggle,
  failureLabel,
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
    setPending({ path, active: !activeBeforeToggle })
    setIsToggling(true)

    try {
      setPending({ path, active: await toggle(path, generation) })
    } catch (cause) {
      setPending(null)
      startOperation(resolvedFailureLabel(failureLabel, activeBeforeToggle)).fail(
        errorMessage(cause),
      )
    } finally {
      setIsToggling(false)
    }
  }

  return { isActive, isToggling, toggleActive }
}
