import type { ReactElement } from 'react'
import { AlarmClock, Calendar, FileText, Pin, Star } from 'lucide-react'
import type { TaskGroup } from '@reflect/core'

/**
 * V1's per-bucket header styling, one definition for the desktop sections and
 * the mobile groups so the two can't drift on bucket colours.
 */

export interface TaskGroupHeaderStyle {
  icon: ReactElement
  colorClass: string
}

/** The icon + accent colour for a group's sticky header, V1's per-bucket styling. */
export function taskGroupHeaderStyle(group: TaskGroup): TaskGroupHeaderStyle {
  switch (group.kind) {
    case 'current':
      return { icon: <Star aria-hidden className="size-4" />, colorClass: 'text-amber-500' }
    case 'overdue':
      return { icon: <AlarmClock aria-hidden className="size-4" />, colorClass: 'text-red-500' }
    case 'upcoming':
      return { icon: <Calendar aria-hidden className="size-4" />, colorClass: 'text-green-600' }
    case 'note':
      return group.tasks[0]?.isPinned
        ? { icon: <Pin aria-hidden className="size-4" />, colorClass: 'text-accent' }
        : { icon: <FileText aria-hidden className="size-4" />, colorClass: 'text-text-secondary' }
  }
}
