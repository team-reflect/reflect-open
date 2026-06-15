import type { ReactElement } from 'react'
import type { TaskGroup } from '@reflect/core'
import { taskKey } from '@/lib/tasks/task-identity'
import { TaskRow } from './task-row'

interface TaskGroupSectionProps {
  group: TaskGroup
  onOpen: (notePath: string) => void
}

/**
 * One section of the Tasks view: a date bucket (Current/Overdue/Upcoming) or a
 * single regular note. Date buckets show each task's source note inline since
 * they aggregate across notes; a note group's header is the note title and
 * opens it, so its rows don't repeat the source.
 */
export function TaskGroupSection({ group, onOpen }: TaskGroupSectionProps): ReactElement {
  const showSource = group.kind !== 'note'
  const { notePath } = group
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        {group.kind === 'note' && notePath !== null ? (
          <button
            type="button"
            onClick={() => onOpen(notePath)}
            className="hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {group.label}
          </button>
        ) : (
          group.label
        )}
      </h2>
      <ul className="space-y-1.5">
        {group.tasks.map((task) => (
          <TaskRow
            key={taskKey(task)}
            task={task}
            showSource={showSource}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  )
}
