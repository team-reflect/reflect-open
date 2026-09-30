import { useEffect, useRef, type RefObject } from 'react'
import { getIsComposing, isModEvent } from '@meowdown/core'
import type { ListSelection } from '@/lib/selection/use-list-selection.ts'
import type { TaskCommands } from '@/lib/tasks/use-task-commands.ts'

export interface TaskKeyboardOptions {
  selection: ListSelection
  commands: TaskCommands
  /** The search box's text, and its setter: Escape clears it. */
  query: string
  setQuery: (value: string) => void
  /** The Tasks surface; shortcuts back off when focus is outside it (another panel). */
  rootRef: RefObject<HTMLElement | null>
  /** ⌘⇧E: open/close the "Task filters" menu (V1). */
  onToggleFilters: () => void
  /** ⌘⇧S: open/close the schedule calendar for the selection (V1). */
  onToggleSchedule: () => void
}

/** Elements that own their own keyboard nav: the shortcuts back off entirely. */
const OWNS_KEYS = '[data-task-editor], [role="menu"], [role="dialog"], [role="listbox"]'

/**
 * The Tasks view's keyboard shortcuts (V1 parity), bound to one `document`
 * keydown listener for the life of the screen, so they work as soon as you
 * are on the Tasks view. Return adds a task, ⌘A selects all, ↑/↓ move the
 * selection (Shift extends), ⌘↵ completes, ⌘⇧↵ archives, ⌘⇧K converts to
 * bullets, ⌘⌫ deletes (plain ⌫ deletes only an empty row), Esc clears the
 * selection and then the search box.
 *
 * The listener backs off when focus is outside the Tasks surface, or inside a
 * control that owns its keys: the inline editor (which binds the same
 * commands itself), a portaled overlay, or the search box (Escape only).
 */
export function useTaskKeyboard({
  selection,
  commands,
  query,
  setQuery,
  rootRef,
  onToggleFilters,
  onToggleSchedule,
}: TaskKeyboardOptions): void {
  const handlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    handlerRef.current = (event) => {
      if (event.defaultPrevented || getIsComposing()) return
      const mod = isModEvent(event)
      // Screen-level chords fire regardless of focus, so the same keys open and
      // close their overlay (the open menu portals outside the surface).
      if (mod && event.shiftKey && (event.key === 'e' || event.key === 'E')) {
        event.preventDefault()
        onToggleFilters()
        return
      }
      if (mod && event.shiftKey && (event.key === 's' || event.key === 'S')) {
        if (selection.selectedCount > 0) {
          event.preventDefault()
          onToggleSchedule()
        }
        return
      }
      const target = event.target as HTMLElement | null
      const root = rootRef.current
      if (root && target && target !== root.ownerDocument.body && !root.contains(target)) return
      if (target?.closest?.(OWNS_KEYS) != null) return
      if (target instanceof HTMLInputElement) {
        if (event.key === 'Escape') {
          setQuery('')
          selection.clear()
          target.blur()
        }
        return
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        if (event.shiftKey) commands.archive()
        else commands.complete()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        commands.continue()
      } else if (mod && event.key === 'Backspace') {
        event.preventDefault()
        commands.remove()
      } else if (event.key === 'Backspace') {
        // Plain ⌫ deletes only a single empty row (V1): never content, and never a
        // multi-selection, which is ambiguous.
        if (selection.selectedCount === 1) {
          event.preventDefault()
          commands.removeEmpty()
        }
      } else if (mod && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault()
        selection.selectAll()
      } else if (mod && event.shiftKey && (event.key === 'k' || event.key === 'K')) {
        if (selection.selectedCount > 0) {
          event.preventDefault()
          commands.convert()
        }
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        commands.navigate(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
      } else if (event.key === 'Escape') {
        // V1 clears the selection and the search query together.
        if (selection.selectedCount > 0 || query !== '') {
          event.preventDefault()
          selection.clear()
          setQuery('')
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
