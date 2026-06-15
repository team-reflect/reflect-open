import type { MouseEvent, ReactElement } from 'react'
import { ArrowRight, Circle, CircleCheck } from 'lucide-react'
import type { OpenTask } from '@reflect/core'
import { formatDayLabel } from '@/lib/dates'
import { taskKey } from '@/lib/tasks/task-identity'
import { useCompleteTask } from '@/lib/tasks/use-complete-task'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { TaskEditor, type TaskNavigate } from './task-editor'
import { TaskText } from './task-text'

interface TaskRowProps {
  task: OpenTask
  /** Show the source-note date — date buckets aggregate tasks from many notes. */
  showSource: boolean
  /** Whether this row is part of the current multi-selection (Plan 18). */
  selected: boolean
  /** Whether this row is the sole selection — it shows the inline editor. */
  editing: boolean
  /** Select the row, honoring ⌘/Ctrl (toggle) and Shift (range) modifiers. */
  onSelect: (event: MouseEvent) => void
  /** Persist an inline edit (content after the marker) and exit edit mode. */
  onEditCommit: (content: string) => void
  /** Enter in the editor: persist this row then add the next task (V1 continuous entry). */
  onEditContinue: (content: string | null) => void
  /** Delete the task from the inline editor (emptied via ⌘↵ / ⌘⌫) and exit edit mode. */
  onEditDelete: () => void
  /** Backspace on an empty row in the editor: delete it and select the previous task. */
  onEditDeleteEmpty: () => void
  /** Exit edit mode without writing (Escape / unchanged). */
  onEditCancel: () => void
  /** ⌘↵ in the editor: complete the task, saving the edit first when `content` isn't null. */
  onEditComplete: (content: string | null) => void
  /** Persist a changed edit when the row unmounts (selection moved), without exiting. */
  onEditFlush: (content: string) => void
  /** ↑/↓ in the editor: move the selection between rows (Shift extends). */
  onEditNavigate: TaskNavigate
  onOpen: (notePath: string) => void
}

/**
 * One task row in the Tasks view (V1 design): a circle checkbox that completes
 * the task (the guarded write-back, Plan 18), the task content with inline date
 * and link chips ({@link TaskText}), the source-note date on the right, and an
 * arrow that opens the source note. Clicking the row body **selects** it (V1's
 * multi-select); a plain click selects exclusively, ⌘/Ctrl toggles, Shift
 * extends a range. Completing optimistically drops the row; an archived
 * (completed) row shows struck through.
 */
export function TaskRow({
  task,
  showSource,
  selected,
  editing,
  onSelect,
  onEditCommit,
  onEditContinue,
  onEditDelete,
  onEditDeleteEmpty,
  onEditCancel,
  onEditComplete,
  onEditFlush,
  onEditNavigate,
  onOpen,
}: TaskRowProps): ReactElement {
  const { settings } = useSettings()
  const { complete, isPending } = useCompleteTask(task)
  const done = task.checked || isPending
  const label = task.text || 'Empty task'

  return (
    <li
      data-task-key={taskKey(task)}
      className={cn(
        'group/task flex items-start gap-3 rounded-md px-2 py-1.5',
        selected ? 'bg-surface-hover ring-1 ring-inset ring-accent' : 'hover:bg-surface-hover',
      )}
    >
      <button
        type="button"
        data-task-row
        aria-label={task.checked ? 'Completed task' : `Complete: ${label}`}
        // Disabled while editing so a checkbox click can't race the editor's
        // write-back (and so focus can't drift off the editor onto it).
        disabled={task.checked || isPending || editing}
        onClick={complete}
        className="mt-px shrink-0 text-text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none disabled:cursor-default"
      >
        {done ? (
          <CircleCheck aria-hidden className="size-[18px] text-accent" strokeWidth={2} />
        ) : (
          <Circle aria-hidden className="size-[18px]" strokeWidth={2} />
        )}
      </button>
      {editing ? (
        <TaskEditor
          task={task}
          onCommit={onEditCommit}
          onContinue={onEditContinue}
          onDelete={onEditDelete}
          onDeleteEmpty={onEditDeleteEmpty}
          onCancel={onEditCancel}
          onComplete={onEditComplete}
          onFlush={onEditFlush}
          onNavigate={onEditNavigate}
        />
      ) : (
        <button
          type="button"
          aria-pressed={selected}
          onClick={(event) => {
            // Shift-click selects a range; stop the browser turning that into a
            // text selection across the rows.
            if (event.shiftKey) {
              event.preventDefault()
            }
            onSelect(event)
          }}
          className={cn(
            'min-w-0 flex-1 break-words text-left text-sm leading-6 text-text focus-visible:outline-none',
            task.checked && 'text-text-muted line-through',
          )}
        >
          <TaskText task={task} />
        </button>
      )}
      {showSource && task.dailyDate !== null ? (
        <span className="mt-0.5 shrink-0 whitespace-nowrap text-xs text-text-muted">
          {formatDayLabel(task.dailyDate, settings.dateFormat)}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={`Open ${task.noteTitle}`}
        // Hidden while editing: keep focus on the editor (Esc first to leave).
        disabled={editing}
        onClick={() => onOpen(task.notePath)}
        className={cn(
          'mt-0.5 shrink-0 text-text-muted/60 opacity-0 transition-opacity hover:text-text focus-visible:opacity-100 focus-visible:outline-none',
          !editing && 'group-hover/task:opacity-100',
        )}
      >
        <ArrowRight aria-hidden className="size-3.5" />
      </button>
    </li>
  )
}
