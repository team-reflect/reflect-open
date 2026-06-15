import { useEffect, useRef, type RefObject } from 'react'
import { type OpenTask } from '@reflect/core'
import { type TaskActions } from '@/lib/tasks/use-task-actions'
import { type TaskSelection } from '@/lib/tasks/use-task-selection'

export interface TaskKeyboardOptions {
  /** The screen's root: shortcuts fire only for keys on this surface (or the body). */
  rootRef: RefObject<HTMLElement | null>
  selection: TaskSelection
  actions: TaskActions
  /** The flat, render-order tasks the selection's keys resolve against. */
  tasksByKey: ReadonlyMap<string, OpenTask>
  /** The search box's text, and its setter — Escape clears it. */
  query: string
  setQuery: (value: string) => void
}

/**
 * The Tasks view's keyboard shortcuts (Plan 18, V1 parity), bound to a single
 * `document` keydown listener for the life of the screen. Kept out of the
 * component so the screen reads as markup + wiring and the shortcut map is one
 * cohesive unit, mirroring {@link useTaskSelection}/{@link useTaskActions}.
 *
 * The map: ⌘A select all, ↑/↓ move a single selection (Shift to extend the
 * range), ⌘↵ complete the selection, ⌘⇧↵ archive (stop showing the session's
 * completed tasks), ⌘⌫ delete (plain ⌫ deletes only empty rows, so a stray
 * Backspace can't lose content), Esc clears the selection then the search box.
 *
 * Scoping rules keep the global listener from hijacking unrelated keys: it
 * ignores anything a focused widget already handled (`defaultPrevented`) or that
 * targets a portaled overlay outside `rootRef`; the search box only honors
 * Escape; and while a sole task's inline editor is focused the editor owns its
 * keys entirely — the bulk shortcuts must not also fire, or a ⌘⌫ would race the
 * editor's own commit-on-unmount with a second write to the same line.
 *
 * The handler closes over the latest render's state but registers once: a ref
 * carries the current closure so the listener stays stable.
 */
export function useTaskKeyboard({
  rootRef,
  selection,
  actions,
  tasksByKey,
  query,
  setQuery,
}: TaskKeyboardOptions): void {
  const handlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  handlerRef.current = (event) => {
    // Respect anything a focused widget already handled (e.g. the filters menu's
    // own arrow/Escape navigation).
    if (event.defaultPrevented) {
      return
    }
    const target = event.target as HTMLElement | null
    // Only the Tasks screen's own surface drives these shortcuts — or the body
    // when nothing is focused. A portaled overlay (the filters menu, a future
    // dialog) renders outside the root, so its keys are never hijacked.
    const onSurface =
      target === document.body || (target !== null && (rootRef.current?.contains(target) ?? false))
    if (!onSurface) {
      return
    }
    const inSearch = target instanceof HTMLInputElement
    const inEditor = target?.closest?.('[data-task-editor]') != null
    const mod = event.metaKey || event.ctrlKey
    const selectedTasks = (): OpenTask[] =>
      [...selection.selected]
        .map((key) => tasksByKey.get(key))
        .filter((task): task is OpenTask => task !== undefined)

    // While editing a sole task the inline editor owns its keys — typing, ⌘A to
    // select its text, and ⌘↵ commit / ⌘⌫ delete for that one task. The bulk
    // shortcuts below must NOT also fire: a ⌘⌫ that both deletes here and lets
    // the editor commit on unmount would race two writes to the same line.
    if (inEditor) {
      return
    }
    if (inSearch) {
      if (event.key === 'Escape') {
        setQuery('')
        selection.clear()
        target.blur()
      }
      return
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) {
        actions.archive() // ⌘⇧↵ — hide the session's completed tasks
      } else {
        actions.complete(selectedTasks())
      }
    } else if (mod && event.key === 'Backspace') {
      event.preventDefault()
      actions.remove(selectedTasks())
      selection.clear()
    } else if (event.key === 'Backspace') {
      // Plain ⌫ deletes only empty rows (V1) — never content, so a stray
      // Backspace can't lose work; ⌘⌫ above is the unconditional delete. The
      // sole-empty case runs in the inline editor; this covers a multi-selection.
      const empties = selectedTasks().filter((row) => row.text.trim() === '')
      if (empties.length > 0) {
        event.preventDefault()
        actions.remove(empties)
      }
    } else if (mod && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault()
      selection.selectAll()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (event.shiftKey) {
        selection.extend(1)
      } else {
        selection.move(1)
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (event.shiftKey) {
        selection.extend(-1)
      } else {
        selection.move(-1)
      }
    } else if (event.key === 'Escape') {
      if (selection.selectedCount > 0) {
        selection.clear()
      } else if (query !== '') {
        setQuery('')
      }
    }
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => handlerRef.current(event)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])
}
