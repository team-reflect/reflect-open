import { type ReactElement } from 'react'
import { Circle, CircleCheck } from 'lucide-react'
import type { OpenTask } from '@reflect/core'
import { TaskBreadcrumbs } from '@/components/tasks/task-breadcrumbs'
import { TaskText } from '@/components/tasks/task-text'
import { formatShortDate } from '@/lib/dates'
import { visibleTaskBreadcrumbs } from '@/lib/tasks/task-breadcrumbs'
import { taskKey } from '@/lib/tasks/task-identity'
import { useTaskCheckboxToggle } from '@/lib/tasks/use-task-checkbox-toggle'
import { cn } from '@/lib/utils'
import { hapticImpactLight } from '@/mobile/haptics'
import { useSettings } from '@/providers/settings-provider'

interface MobileTaskRowProps {
  task: OpenTask
  /** Show the source-note date — date buckets aggregate tasks from many notes. */
  showSource: boolean
  /** Open the quick-edit sheet for this task (V1 mobile: tap edits in place). */
  onEdit: (task: OpenTask) => void
}

/**
 * One task row on the mobile Tasks tab (V1 mobile design over Plan 18 data): a
 * round checkbox that toggles the task through the same guarded write-back as
 * desktop — with a light haptic, V1's check feedback — and the task content
 * rendered as markdown. A completed (struck) row stays visible until archived.
 * Tapping the row body gives the same light confirmation and opens the
 * quick-edit sheet instead of desktop's multi-select; there is no inline editor
 * on touch.
 */
export function MobileTaskRow({ task, showSource, onEdit }: MobileTaskRowProps): ReactElement {
  const { settings } = useSettings()
  const { toggle, isPending } = useTaskCheckboxToggle(task)
  const label = task.text || 'Empty task'
  const edit = (): void => onEdit(task)
  const breadcrumbs = visibleTaskBreadcrumbs(task.breadcrumbs)
  const hasBreadcrumbs = breadcrumbs.length > 0

  return (
    <li
      data-task-key={taskKey(task)}
      className="grid min-h-12 grid-cols-[auto,minmax(0,1fr)] border-b border-border bg-surface"
    >
      {hasBreadcrumbs ? (
        <TaskBreadcrumbs
          breadcrumbs={breadcrumbs}
          className="col-start-2 mb-0 min-w-0 pr-4 pt-3"
        />
      ) : null}
      <button
        type="button"
        aria-label={task.checked ? `Reopen: ${label}` : `Complete: ${label}`}
        disabled={isPending}
        onClick={() => {
          hapticImpactLight()
          toggle()
        }}
        // A generous touch target around the small glyph; self-stretch keeps
        // the circle vertically centered in the row as task text wraps.
        className={cn(
          'col-start-1 flex shrink-0 pl-4 pr-3 text-text-muted disabled:opacity-50',
          hasBreadcrumbs
            ? 'row-start-2 items-start pb-3 pt-0.5'
            : 'row-start-1 self-stretch items-center',
        )}
      >
        {task.checked ? (
          <CircleCheck aria-hidden className="size-5 text-accent" strokeWidth={2} />
        ) : (
          <Circle aria-hidden className="size-5" strokeWidth={2} />
        )}
      </button>
      {/* A div with the button role, not a real <button>: the markdown inside
          can contain links, and interactive content can't nest in a button
          (desktop's row body makes the same trade). TaskText itself is
          pointer-events-none, so taps land here. */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Edit: ${label}`}
        onClick={edit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            edit()
          }
        }}
        className={cn(
          'col-start-2 flex min-w-0 cursor-pointer items-start gap-3 pr-4 text-left focus-visible:outline-none',
          hasBreadcrumbs ? 'row-start-2 pb-3' : 'row-start-1 py-3',
        )}
      >
        <div className="min-w-0 flex-1 break-words text-sm leading-6 text-text">
          <div className={cn(task.checked && 'text-text-muted line-through')}>
            <TaskText task={task} />
          </div>
        </div>
        {showSource && task.dailyDate !== null ? (
          // The compact date, not desktop's long day label — a phone row can't
          // spare "Mon, June 1st, 2026" (V1 mobile's small gray source label).
          <span className="mt-0.5 shrink-0 whitespace-nowrap text-xs text-text-muted">
            {formatShortDate(task.dailyDate, settings.dateFormat)}
          </span>
        ) : null}
      </div>
    </li>
  )
}
