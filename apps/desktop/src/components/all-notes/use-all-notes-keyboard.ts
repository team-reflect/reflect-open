import { useEffect, useRef, type RefObject } from 'react'
import { type ListSelection } from '@/lib/selection/use-list-selection'

export interface AllNotesKeyboardOptions {
  selection: ListSelection
  /** The note paths in render order — the selection's keys resolve against these. */
  orderedPaths: readonly string[]
  /** Open a note in the editor (Enter / ⌘Enter on the selection). */
  onOpen: (path: string) => void
  /** Ask to trash the selection (⌘⌫) — the screen opens its confirm dialog. */
  onRequestTrash: () => void
  /** The All Notes surface; shortcuts back off when focus is outside it. */
  rootRef: RefObject<HTMLElement | null>
  /** Bring a row into view after a keyboard move (V1 scrolls the selection). */
  scrollToIndex: (index: number) => void
}

/** Elements that own their own keyboard nav — the shortcuts back off entirely. */
const OWNS_KEYS = '[role="menu"], [role="dialog"], [role="listbox"], input, textarea'

/**
 * The All Notes view's keyboard shortcuts (V1 parity), bound to a single
 * `document` keydown listener for the screen's life — so they work the moment
 * you're on the screen (which focuses its surface on mount), without first
 * clicking into the list. Mirrors {@link import('@/lib/tasks/use-task-keyboard').useTaskKeyboard},
 * with a smaller map: there's no inline editor and no add/complete here.
 *
 * The map: ↑/↓ move a single selection (Shift to extend the range), ⌘A select
 * all, Return / ⌘Return open the first selected note, ⌘⌫ trash the selection
 * (the screen confirms first — plain ⌫/Delete is deliberately *not* bound, so a
 * stray keypress can't bulk-trash), Esc clear.
 *
 * Scoping: the listener is on `document`, but backs off when focus sits outside
 * the surface (the sidebar or another panel keeps its own keys — only `body`/no
 * focus and elements inside the surface drive the shortcuts), and within the
 * surface it backs off for a focused control that owns the key — the Custom
 * filter combobox, a portaled menu, or the trash-confirm dialog.
 *
 * The handler closes over the latest render's state but registers once: a ref
 * carries the current closure so the listener stays stable.
 */
export function useAllNotesKeyboard({
  selection,
  orderedPaths,
  onOpen,
  onRequestTrash,
  rootRef,
  scrollToIndex,
}: AllNotesKeyboardOptions): void {
  const handlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    handlerRef.current = (event) => {
      // Respect anything a focused widget already handled (e.g. the combobox's
      // own arrow/Escape navigation).
      if (event.defaultPrevented) {
        return
      }
      const target = event.target as HTMLElement | null
      // Focus outside the surface keeps its own keys; `body`/no-focus and elements
      // inside the surface drive the shortcuts.
      const root = rootRef.current
      if (root !== null && target !== null && target !== root.ownerDocument.body && !root.contains(target)) {
        return
      }
      // Back off for a focused control inside the surface that owns the key.
      if (target?.closest?.(OWNS_KEYS) != null) {
        return
      }
      const mod = event.metaKey || event.ctrlKey
      const scrollActiveIntoView = (): void => {
        const key = selection.activeKey()
        if (key !== null) {
          scrollToIndex(orderedPaths.indexOf(key))
        }
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (event.shiftKey) {
          selection.extend(1)
        } else {
          selection.move(1)
        }
        scrollActiveIntoView()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (event.shiftKey) {
          selection.extend(-1)
        } else {
          selection.move(-1)
        }
        scrollActiveIntoView()
      } else if (mod && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault()
        selection.selectAll()
      } else if (event.key === 'Enter') {
        // V1: Return / ⌘Return open the first selected note (render order).
        const firstSelected = orderedPaths.find((path) => selection.isSelected(path))
        if (firstSelected !== undefined) {
          event.preventDefault()
          onOpen(firstSelected)
        }
      } else if (mod && event.key === 'Backspace') {
        if (selection.selectedCount > 0) {
          event.preventDefault()
          onRequestTrash()
        }
      } else if (event.key === 'Escape') {
        if (selection.selectedCount > 0) {
          event.preventDefault()
          selection.clear()
        }
      }
    }
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => handlerRef.current(event)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])
}
