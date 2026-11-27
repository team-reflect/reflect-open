import type { NativeContextMenuItem } from '@reflect/app'
import type { OpenTask } from '@reflect/core'
import { getTaskDatePresets } from './task-date-presets.ts'

/**
 * What the task menu actions do to the tasks the menu was opened for.
 */
export interface TaskMenuActions {
  toggle: () => void
  schedule: (isoDate: string | null) => void
  convert: () => void
  remove: () => void
  openNote: (openInNewWindow: boolean) => void
}

/**
 * The context menu items for `tasks`, the targets of a right-click on the
 * Tasks screen.
 */
export function getTaskMenuItems(
  tasks: readonly OpenTask[],
  today: string,
): NativeContextMenuItem[] {
  const sole = tasks.length === 1 ? tasks[0] : undefined
  const notePath = tasks[0]?.notePath
  const items: NativeContextMenuItem[] = [
    tasks.some((task) => !task.checked)
      ? { type: 'action', id: 'complete', title: 'Complete', shortcut: 'Mod-Enter' }
      : { type: 'action', id: 'reopen', title: 'Reopen', shortcut: 'Mod-Enter' },
    {
      type: 'submenu',
      title: 'Schedule',
      items: [
        ...getTaskDatePresets(today).map((preset): NativeContextMenuItem => {
          return {
            type: 'action',
            id: preset.id,
            title: preset.label,
            checked: sole?.dueDate === preset.date,
          }
        }),
        { type: 'separator' },
        {
          type: 'action',
          id: 'clear-date',
          title: 'Clear date',
          disabled: tasks.every((task) => task.dueDate === null),
        },
      ],
    },
    { type: 'action', id: 'convert', title: 'Convert to bullet', shortcut: 'Mod-Shift-k' },
  ]
  if (tasks.every((task) => task.notePath === notePath)) {
    items.push(
      { type: 'separator' },
      { type: 'action', id: 'open-note', title: 'Open note' },
      { type: 'action', id: 'open-note-in-new-window', title: 'Open note in new window' },
    )
  }
  items.push(
    { type: 'separator' },
    { type: 'action', id: 'delete', title: 'Delete', shortcut: 'Mod-Backspace' },
  )
  return items
}

/**
 * Runs the action of the item `id` from {@link getTaskMenuItems}.
 */
export function runTaskMenuAction(id: string, today: string, actions: TaskMenuActions): void {
  const preset = getTaskDatePresets(today).find((candidate) => candidate.id === id)
  if (preset !== undefined) {
    actions.schedule(preset.date)
    return
  }
  switch (id) {
    case 'complete':
    case 'reopen':
      actions.toggle()
      break
    case 'clear-date':
      actions.schedule(null)
      break
    case 'convert':
      actions.convert()
      break
    case 'open-note':
      actions.openNote(false)
      break
    case 'open-note-in-new-window':
      actions.openNote(true)
      break
    case 'delete':
      actions.remove()
      break
  }
}
