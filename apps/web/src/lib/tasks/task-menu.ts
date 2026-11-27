import type { ContextMenuItem } from '@reflect/app'
import type { OpenTask } from '@reflect/core'
import { getTaskDatePresets } from './task-date-presets.ts'

export type TaskMenuId =
  | 'toggle'
  | `schedule:${string}`
  | 'clear-date'
  | 'convert'
  | 'open-note'
  | 'open-note-in-new-window'
  | 'delete'

type TaskMenuItem =
  | (Extract<ContextMenuItem, { type: 'action' }> & { id: TaskMenuId })
  | { type: 'separator' }
  | { type: 'submenu'; title: string; items: TaskMenuItem[] }

export function getTaskMenuItems(tasks: readonly OpenTask[], today: string): TaskMenuItem[] {
  const notePath = tasks[0]?.notePath
  const items: TaskMenuItem[] = [
    {
      type: 'action',
      id: 'toggle',
      title: tasks.some((task) => !task.checked) ? 'Complete' : 'Reopen',
      shortcut: 'Mod-Enter',
    },
    {
      type: 'submenu',
      title: 'Schedule',
      items: [
        ...getTaskDatePresets(today).map((preset): TaskMenuItem => {
          return {
            type: 'action',
            id: `schedule:${preset.date}`,
            title: preset.title,
            checked: tasks.every((task) => task.dueDate === preset.date),
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
