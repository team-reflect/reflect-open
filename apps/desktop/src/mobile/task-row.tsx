import type { ReactElement } from 'react'
import { ArrowRight, Circle, CircleCheck, Trash2 } from 'lucide-react'
import type { OpenTask } from '@reflect/core'
import { getIsComposing } from '@meowdown/core'
import { TaskText } from '@/components/tasks/task-text'
import { formatShortDate } from '@/lib/dates'
import { taskKey } from '@/lib/tasks/task-identity'
import { useTaskCheckboxToggle } from '@/lib/tasks/use-task-checkbox-toggle'
import { cn } from '@/lib/utils'
import { hapticImpactLight } from '@/mobile/haptics'
import { SWIPE_ACTION_WIDTH, SwipeActionButton } from '@/mobile/swipe-action-button'
import { useRowSwipe } from '@/mobile/use-row-swipe'
import { useSettings } from '@/providers/settings-provider'

/** Total width of the two actions (open note, delete) under every task row. */
const ACTION_WIDTH = SWIPE_ACTION_WIDTH * 2

interface MobileTaskRowProps {
  task: OpenTask
  /** Show the source-note date — date buckets aggregate tasks from many notes. */
  showSource: boolean
  /** Open the quick-edit sheet for this task (V1 mobile: tap edits in place). */
  onEdit: (task: OpenTask) => void
  revealed: boolean
  onReveal: () => void
  onClose: () => void
  onBeginInteraction: () => void
  /** Navigate to the task's source note (the revealed Note action). */
  onOpenNote: () => void
  /** Delete the task outright; no confirmation, matching the sheet's Delete. */
  onDelete: () => void
}

/**
 * One task row on the mobile Tasks tab (V1 mobile design over Plan 18 data): a
 * round checkbox that toggles the task through the same guarded write-back as
 * desktop — with a light haptic, V1's check feedback — and the task content
 * rendered as markdown. A completed (struck) row stays visible until archived.
 * Tapping the row body gives the same light confirmation and opens the
 * quick-edit sheet instead of desktop's multi-select; there is no inline editor
 * on touch. Swiping the row left reveals the note list's gesture on tasks: an
 * open-note action and a delete action ({@link useRowSwipe} owns the physics).
 */
export function MobileTaskRow({
  task,
  showSource,
  onEdit,
  revealed,
  onReveal,
  onClose,
  onBeginInteraction,
  onOpenNote,
  onDelete,
}: MobileTaskRowProps): ReactElement {
  const { settings } = useSettings()
  const { toggle, isPending } = useTaskCheckboxToggle(task)
  const label = task.text || 'Empty task'
  const edit = (): void => onEdit(task)
  const swipe = useRowSwipe({
    actionWidth: ACTION_WIDTH,
    revealed,
    onReveal,
    onClose,
    onBeginInteraction,
  })

  return (
    <li data-task-key={taskKey(task)} className="relative overflow-hidden border-b border-border">
      <div
        className="absolute inset-y-0 right-0 flex"
        style={{ width: ACTION_WIDTH }}
        aria-hidden={!revealed || undefined}
        inert={!revealed}
      >
        <SwipeActionButton
          icon={<ArrowRight className="size-4" />}
          label="Note"
          ariaLabel={`Open note: ${label}`}
          revealed={revealed}
          className="bg-accent"
          onClick={() => {
            hapticImpactLight()
            onClose()
            onOpenNote()
          }}
        />
        <SwipeActionButton
          icon={<Trash2 className="size-4" />}
          label="Delete"
          ariaLabel={`Delete: ${label}`}
          revealed={revealed}
          className="bg-destructive"
          onClick={() => {
            hapticImpactLight()
            onClose()
            onDelete()
          }}
        />
      </div>
      <div
        ref={swipe.ref}
        {...swipe.handlers}
        // One capture handler covers both interactive children: swallow the
        // synthetic click a completed drag leaves behind, and turn a tap on a
        // revealed row into a plain close (iOS list behavior).
        onClickCapture={(event) => {
          if (swipe.consumeDragClick()) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (revealed) {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}
        className="relative flex min-h-12 items-start bg-surface"
      >
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
          className="flex shrink-0 self-stretch items-center pl-4 pr-3 text-text-muted disabled:opacity-50"
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
            if (getIsComposing()) {
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              edit()
            }
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 py-3 pr-4 text-left focus-visible:outline-none"
        >
          <span
            className={cn(
              'min-w-0 flex-1 break-words text-sm leading-6 text-text',
              task.checked && 'text-text-muted line-through',
            )}
          >
            <TaskText task={task} />
          </span>
          {showSource && task.dailyDate !== null ? (
            // The compact date, not desktop's long day label — a phone row can't
            // spare "Mon, June 1st, 2026" (V1 mobile's small gray source label).
            <span className="mt-0.5 shrink-0 whitespace-nowrap text-xs text-text-muted">
              {formatShortDate(task.dailyDate, settings.dateFormat)}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  )
}
