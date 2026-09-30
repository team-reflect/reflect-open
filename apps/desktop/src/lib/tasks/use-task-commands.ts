import { useMemo } from 'react'
import type { Task, TaskPatch, TaskStore, TaskTarget } from '@reflect/core'
import type { ListSelection } from '@/lib/selection/use-list-selection.ts'
import { continueFrom, previousTaskKey } from '@/lib/tasks/task-navigation.ts'

/**
 * What the Tasks view does to tasks, whether the key came from the list or
 * from a row's inline editor (V1: navigation and entry are global). Each
 * command changes the store and then the selection: a row leaves edit mode
 * when its task is completed, converted, or removed, and continuous entry
 * selects the row it just added.
 */
export interface TaskCommands {
  /**
   * Return or Enter: save `task`'s draft (the active selected row by default),
   * add the next task, and select it. Without a task, add to today's daily.
   */
  continue: (task?: Task) => void
  /** ⌘↵: complete the selection, or reopen it when every row is checked. Keeps the selection. */
  complete: () => void
  /** A row's checkbox: the row's next state, applied to the whole selection when the row is in a multi-selection. */
  check: (task: Task) => void
  /** ⌘⌫: delete the selection. */
  remove: () => void
  /** Backspace on an empty sole row: delete it and land on the previous row. */
  removeEmpty: () => void
  /** ⌘⇧K: turn the selection into plain bullets. */
  convert: () => void
  /** ⌘⇧S or the calendar: set or clear the selection's due date. */
  schedule: (isoDate: string | null) => void
  /** A group's "+ Add": add an empty task there and select it. */
  add: (target: TaskTarget) => void
  /** ↑ / ↓ (Shift to extend): move the selection. */
  navigate: (direction: -1 | 1, span: boolean) => void
  /** Escape: leave edit mode. */
  cancel: () => void
  /** ⌘⇧↵: stop showing the session's completed tasks. */
  archive: () => void
}

export function useTaskCommands({
  store,
  selection,
  tasksByKey,
  orderedTasks,
  today,
  scrollToKey,
}: {
  store: TaskStore | null
  selection: ListSelection
  /** The rendered tasks by key, which the selection's keys resolve against. */
  tasksByKey: ReadonlyMap<string, Task>
  /** The flat, render-order tasks, used to pick the row to select after a delete. */
  orderedTasks: readonly Task[]
  today: string
  /** Bring a row into view after a keyboard move (V1 scrolls the selection). */
  scrollToKey: (key: string | null) => void
}): TaskCommands {
  return useMemo(() => {
    const selected = () => [...selection.selected].flatMap((key) => tasksByKey.get(key) ?? [])
    // The pivot must still be selected: `activeKey()` keeps pointing at the last
    // touched row after deselection.
    const active = () => {
      const key = selection.activeKey()
      return key !== null && selection.selected.has(key) ? tasksByKey.get(key) : undefined
    }
    const selectOnly = (key: string | null) => {
      if (key === null) selection.clear()
      else {
        selection.clickSelect(key, { metaKey: false, ctrlKey: false, shiftKey: false })
        scrollToKey(key)
      }
    }
    const leave = (patch: TaskPatch) => {
      store?.update(selected(), patch)
      selection.clear()
    }
    return {
      continue: (task = active()) =>
        selectOnly((store && continueFrom(store, task, today))?.key ?? null),
      complete: () => {
        const tasks = selected()
        store?.update(tasks, { checked: !tasks.every((task) => store.current(task).checked) })
      },
      check: (task) => {
        const tasks = selected()
        const inSelection = tasks.length > 1 && tasks.some((other) => other.key === task.key)
        store?.update(inSelection ? tasks : [task], { checked: !task.checked })
      },
      remove: () => leave({ gone: 'removed' }),
      removeEmpty: () => {
        const [task] = selected()
        if (!task || !store) return
        const previous = previousTaskKey(orderedTasks, task)
        // Ending the edit removes an emptied draft or an untouched new task; a
        // saved empty task goes too. A row with content stays (V1).
        if (store.commitDraft(task) !== null) {
          if (store.current(task).text.trim() !== '') return
          store.update(task, { gone: 'removed' })
        }
        selectOnly(previous)
      },
      convert: () => leave({ gone: 'bullet' }),
      schedule: (isoDate) => leave({ dueDate: isoDate }),
      add: (target) => selectOnly(store?.create(target).key ?? null),
      navigate: (direction, span) => {
        if (span) selection.extend(direction)
        else selection.move(direction)
        scrollToKey(selection.activeKey())
      },
      cancel: () => selection.clear(),
      archive: () => store?.archive(),
    }
  }, [store, selection, tasksByKey, orderedTasks, today, scrollToKey])
}
