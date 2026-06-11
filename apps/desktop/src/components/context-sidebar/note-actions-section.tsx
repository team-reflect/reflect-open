import { useState, type ReactElement } from 'react'
import { errorMessage } from '@reflect/core'
import { PinIcon } from '@/components/icons/pin-icon'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { usePinnedNotes } from '@/hooks/use-pinned-notes'
import { keybindingFor } from '@/lib/commands/app-commands'
import { toggleNotePinned } from '@/lib/note-pin'
import { startOperation } from '@/lib/operations'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'
import { SidebarSection } from './sidebar-section'

interface NoteActionsSectionProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
}

// Derived from the `note.togglePin` command definition so the hint can never
// drift from the real binding (the same contract as the Today hint).
const PIN_KEYBINDING = keybindingFor('note.togglePin')

/**
 * The toggle's resolved state, held until the index reflects it. The pinned
 * label otherwise lags one watcher round-trip behind the write, and in that
 * window a stale "Pin this note" click would silently unpin (and vice versa). The
 * toggle reads the note itself, so its return value is the freshest truth;
 * the bridge retires the moment the index agrees or the section moves to
 * another note.
 */
interface PendingPin {
  path: string
  pinned: boolean
}

/**
 * "Note actions" as a context-sidebar section: mouse-reachable counterparts
 * to the note-scoped commands, starting with pin/unpin. Shared by the daily
 * and note context sidebars — dailies are valid pin targets too. The button
 * reflects the index's pinned state (the same query as the sidebar's Pinned
 * section), bridged by the last toggle's result while the watcher catches
 * up; failures surface through the operations status line, like the ⌘O
 * command.
 */
export function NoteActionsSection({ path }: NoteActionsSectionProps): ReactElement {
  const { graph } = useGraph()
  const indexPinned = usePinnedNotes().some((note) => note.path === path)
  // Guards against a double-click racing two read-patch-write toggles.
  const [isToggling, setIsToggling] = useState(false)
  const [pending, setPending] = useState<PendingPin | null>(null)

  // Render-time state adjustment (the React-sanctioned pattern): drop the
  // bridge once the index agrees with it, so a later external pin change
  // can't resurrect a stale override.
  if (pending !== null && (pending.path !== path || pending.pinned === indexPinned)) {
    setPending(null)
  }
  const isPinned = pending !== null && pending.path === path ? pending.pinned : indexPinned

  const togglePin = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined) {
      return
    }
    setIsToggling(true)
    try {
      setPending({ path, pinned: await toggleNotePinned(path, generation) })
    } catch (cause) {
      startOperation(isPinned ? 'Unpinning note' : 'Pinning note').fail(errorMessage(cause))
    } finally {
      setIsToggling(false)
    }
  }

  return (
    <SidebarSection storageKey="note-actions" title="Note actions">
      <button
        type="button"
        onClick={() => void togglePin()}
        disabled={isToggling}
        className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start transition-colors duration-100 hover:bg-surface-hover disabled:opacity-50"
      >
        <span
          className={cn(
            'flex h-5 w-5 flex-none items-center justify-center transition-colors duration-100',
            isPinned ? 'text-accent' : 'text-text-muted group-hover:text-text',
          )}
        >
          <PinIcon width={20} height={20} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {isPinned ? 'Un-pin this note' : 'Pin this note'}
        </span>
        {PIN_KEYBINDING !== null ? (
          <ShortcutKeys
            binding={PIN_KEYBINDING}
            className="invisible group-hover:visible"
          />
        ) : null}
      </button>
    </SidebarSection>
  )
}
