import type { ReactElement } from 'react'
import { AlarmClock, Calendar, FileText, Pin, Star } from 'lucide-react'
import type { TaskGroup } from '@reflect/core'
import type { InsertTaskTarget } from '@/lib/tasks/task-insert-target.ts'
import { todaysDailyTarget } from '@/lib/tasks/task-navigation.ts'

/**
 * The presentation contract a task-group section shares across surfaces —
 * V1's per-bucket styling and add-target rule, one definition for the desktop
 * sections and the mobile groups so the two can't drift on bucket colours or
 * where "+ Add" writes.
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

/**
 * Where this group's add button adds a task (V1: Current → today's daily, a
 * note → that note), or `null` for the aggregate Overdue/Upcoming buckets,
 * which span many notes and so show no add button.
 */
export function addTargetForGroup(group: TaskGroup, today: string): InsertTaskTarget | null {
  if (group.kind === 'current') {
    return todaysDailyTarget(today)
  }
  const first = group.tasks[0]
  return group.kind === 'note' && first !== undefined ? first : null
}
