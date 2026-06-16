import { useEffect, useRef, type RefObject } from 'react'
import { type OpenTask } from '@reflect/core'
import { taskKey } from '@/lib/tasks/task-identity'
import {
  insertTargetForBucket,
  previousTaskKey,
  todaysDailyTarget,
} from '@/lib/tasks/task-navigation'
import { type InsertTaskTarget, type TaskActions } from '@/lib/tasks/use-task-actions'
import { type TaskSelection } from '@/lib/tasks/use-task-selection'

export interface TaskKeyboardOptions {
  selection: TaskSelection
  actions: TaskActions
  /** The flat, render-order tasks the selection's keys resolve against. */
  tasksByKey: ReadonlyMap<string, OpenTask>
  /** The flat, render-order tasks — used to pick the row to select after a delete. */
  orderedTasks: readonly OpenTask[]
  /** The search box's text, and its setter — Escape clears it. */
  query: string
  setQuery: (value: string) => void
  /** Today's ISO date — Return with no selection adds a task to today's daily. */
  today: string
  /** The Tasks surface; shortcuts back off when focus is outside it (another panel). */
  rootRef: RefObject<HTMLElement | null>
  /** Bring a row into view after a keyboard move (V1 scrolls the selection). */
  scrollToKey: (key: string | null) => void
  /** ⌘⇧E: open/close the "Task filters" menu (V1). */
  onToggleFilters: () => void
  /** ⌘⇧S: open/close the schedule calendar for the selection (V1). */
  onToggleSchedule: () => void
}

/** Elements that own their own keyboard nav — the shortcuts back off entirely. */
const OWNS_KEYS = '[data-task-editor], [role="menu"], [role="dialog"], [role="listbox"]'

/**
 * The Tasks view's keyboard shortcuts (Plan 18, V1 parity), bound to a single
 * `document` keydown listener for the life of the screen — so they work as soon
 * as you're on the Tasks view, without first clicking into the list. Kept out of
 * the component so the screen reads as markup + wiring and the shortcut map is
 * one cohesive unit, mirroring {@link useTaskSelection}/{@link useTaskActions}.
 *
 * The map: Return adds a task (to the selected task's note, else today's daily),
 * ⌘A select all, ↑/↓ move a single selection (Shift to extend the range), ⌘↵
 * complete the selection, ⌘⇧↵ archive (stop showing the session's completed
 * tasks), ⌘⌫ delete (plain ⌫ deletes only empty rows, so a stray Backspace can't
 * lose content), Esc clears the selection then the search box.
 *
 * Scoping: the listener is on `document` (so the shortcuts work the moment you're
 * on Tasks, no click needed — the screen focuses its surface on mount), but backs
 * off when focus sits **outside** the Tasks surface — the workspace sidebar or
 * another panel keeps its own keys. Within the surface it still backs off for a
 * focused control that owns the key: the inline editor (it owns its keys, and a
 * ⌘⌫ there must not race its commit-on-unmount), a portaled overlay (the filters
 * menu, a dialog, the ⌘K palette), or the search box (which honors only Escape).
 * Everything else on the Tasks surface — a focused row or nothing focused — drives
 * the shortcuts.
 *
 * The handler closes over the latest render's state but registers once: a ref
 * carries the current closure so the listener stays stable.
 */
export function useTaskKeyboard({
  selection,
  actions,
  tasksByKey,
  orderedTasks,
  query,
  setQuery,
  today,
  rootRef,
  scrollToKey,
  onToggleFilters,
  onToggleSchedule,
}: TaskKeyboardOptions): void {
  const handlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    handlerRef.current = (event) => {
      // Respect anything a focused widget already handled (e.g. the filters menu's
      // own arrow/Escape navigation).
      if (event.defaultPrevented) {
        return
      }
      // ⌘⇧E toggles the filters menu (V1) — a screen-level chord that fires
      // regardless of focus, before the surface-scoping bails, so the same keys
      // open and close it (the open menu portals outside the surface).
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'e' || event.key === 'E')) {
        event.preventDefault()
        onToggleFilters()
        return
      }
      // ⌘⇧S opens/closes the schedule calendar for the selection (V1) — also a
      // screen-level chord, but only when there's something to schedule.
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 's' || event.key === 'S')) {
        if (selection.selectedCount > 0) {
          event.preventDefault()
          onToggleSchedule()
        }
        return
      }
      const target = event.target as HTMLElement | null
      // Focus outside the Tasks surface (the workspace sidebar, another panel) keeps
      // its own keys — only `body`/no-focus and elements inside the surface drive the
      // shortcuts. `body` is allowed so they still fire when focus falls back to it.
      const root = rootRef.current
      if (root !== null && target !== null && target !== root.ownerDocument.body && !root.contains(target)) {
        return
      }
      // Back off when a focused control inside the surface owns the key: the inline
      // editor (it owns its keys, and a ⌘⌫ there must not race its commit-on-unmount)
      // or a portaled overlay (filters menu, dialog, ⌘K palette).
      if (target?.closest?.(OWNS_KEYS) != null) {
        return
      }
      const inSearch = target instanceof HTMLInputElement
      // The note a Return-inserted task lands in (V1 group-based): the active row's
      // group — Current → today's daily, a note → that note, Overdue/Upcoming refuse
      // (`null`) — else, with nothing selected, today's daily. The pivot must still be
      // *selected*: `activeKey()` keeps pointing at the last-touched row even after a
      // ⌘-click deselects it (or all of them), so an unselected pivot falls to today.
      const insertTarget = (): InsertTaskTarget | null => {
        const activeKey = selection.activeKey()
        const active =
          activeKey !== null && selection.selected.has(activeKey)
            ? tasksByKey.get(activeKey)
            : undefined
        return active !== undefined ? insertTargetForBucket(active, today) : todaysDailyTarget(today)
      }
      const selectExclusively = (key: string): void => {
        selection.clickSelect(key, { metaKey: false, ctrlKey: false, shiftKey: false })
        scrollToKey(key)
      }
      const mod = event.metaKey || event.ctrlKey
      const selectedTasks = (): OpenTask[] =>
        [...selection.selected]
          .map((key) => tasksByKey.get(key))
          .filter((task): task is OpenTask => task !== undefined)

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
          actions.toggle(selectedTasks()) // ⌘↵ — complete, or reopen if all checked
        }
      } else if (event.key === 'Enter') {
        // Return adds a task (V1). A sole selection's editor owns Enter (it bailed
        // above via OWNS_KEYS and continues the entry there), so this fires from the
        // list itself: insert, then select the new row to open its editor focused.
        // A null target means the active row is Overdue/Upcoming — nothing to add to.
        // Skip while a write is in flight so a held/rapid Return can't append several
        // empty rows before the first insert's editor takes focus.
        event.preventDefault()
        const target = insertTarget()
        if (target !== null && !actions.isPending) {
          void actions.insert(target).then((created) => {
            if (created !== null) {
              selectExclusively(taskKey(created))
            }
          })
        }
      } else if (mod && event.key === 'Backspace') {
        event.preventDefault()
        actions.remove(selectedTasks())
        selection.clear()
      } else if (event.key === 'Backspace') {
        // Plain ⌫ deletes only a single empty row (V1) — never content, and never a
        // multi-selection (which is ambiguous). The sole-selection case usually runs
        // in the focused editor; here it covers an unfocused single selection, and
        // lands on the previous row so the keyboard flow continues.
        const selected = selectedTasks()
        const sole = selected.length === 1 ? selected[0] : undefined
        if (sole !== undefined && sole.text.trim() === '') {
          event.preventDefault()
          const previous = previousTaskKey(orderedTasks, sole)
          actions.remove(selected)
          if (previous !== null) {
            selectExclusively(previous)
          } else {
            selection.clear()
          }
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
        scrollToKey(selection.activeKey())
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (event.shiftKey) {
          selection.extend(-1)
        } else {
          selection.move(-1)
        }
        scrollToKey(selection.activeKey())
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
