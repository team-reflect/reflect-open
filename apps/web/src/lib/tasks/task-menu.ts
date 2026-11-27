import type { ContextMenuAction, ContextMenuSeparator } from '@reflect/app'
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
  | (ContextMenuAction & { id: TaskMenuId })
  | ContextMenuSeparator
  | { type: 'submenu'; title: string; items: TaskMenuItem[] }

export function getTaskMenuItems(tasks: readonly OpenTask[], today: string): TaskMenuItem[] {
  const notePath = tasks[0]?.notePath
  const items: TaskMenuItem[] = [
    {
      type: 'action',
      id: 'toggle',
      title: tasks.some((task) => !task.checked) ? 'Mark as Completed' : 'Mark as Incomplete',
    },
    {
      type: 'submenu',
      title: 'Due Date',
      items: [
        ...getTaskDatePresets(today).map((preset): TaskMenuItem => {
          return {
            type: 'action',
            id: `schedule:${preset.date}`,
            title: preset.menuTitle,
            checked: tasks.every((task) => task.dueDate === preset.date),
          }
        }),
        { type: 'separator' },
        {
          type: 'action',
          id: 'clear-date',
          title: 'None',
          checked: tasks.every((task) => task.dueDate === null),
        },
      ],
    },
    { type: 'action', id: 'convert', title: 'Convert to Bullet' },
  ]
  if (tasks.every((task) => task.notePath === notePath)) {
    items.push(
      { type: 'separator' },
      { type: 'action', id: 'open-note', title: 'Open Note' },
      { type: 'action', id: 'open-note-in-new-window', title: 'Open Note in New Window' },
    )
  }
  items.push({ type: 'separator' }, { type: 'action', id: 'delete', title: 'Delete' })
  return items
}
