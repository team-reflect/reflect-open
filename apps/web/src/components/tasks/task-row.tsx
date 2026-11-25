import { memo, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { Circle, CircleCheck } from 'lucide-react'
import type { OpenTask } from '@reflect/core'
import { getIsComposing } from '@meowdown/core'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/hooks/use-note-link-navigation.ts'
import { TaskEditor, type TaskEditorHandlers } from './task-editor.tsx'
import { TaskText } from './task-text.tsx'
import { useNoteLabel } from '@/hooks/use-note-label.ts'

/**
 * Minimum height (px) of a row with its bottom border: a single-line row.
 */
export const TASK_ROW_HEIGHT = 41

interface TaskRowProps {
  task: OpenTask
  /**
   * Show the source-note date — date buckets aggregate tasks from many notes.
   */
  showSource: boolean
  /**
   * Whether this row is part of the current multi-selection (Plan 18).
   */
  selected: boolean
  /**
   * Select a task, honoring ⌘/Ctrl (toggle) and Shift (range) modifiers.
   */
  onSelect: (taskId: string, event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void
  /**
   * A click on the checkbox of a task.
   */
  onCheckboxToggle: (task: OpenTask) => void
  /**
   * What the keys of the inline editor do for this row. Set while the row is
   * the sole selection: it then shows the inline editor.
   */
  editHandlers: TaskEditorHandlers | undefined
  onOpen: (notePath: string, event?: ModClickEvent) => void
}

/**
 * One task row in the Tasks view (V1 design): a circle checkbox that toggles
 * the task (the guarded write-back, Plan 18), the task content with inline date
 * and link chips ({@link TaskText}), and a source-note link on the right.
 * Clicking the row body **selects** it (V1's
 * multi-select); a plain click selects exclusively, ⌘/Ctrl toggles, Shift
 * extends a range. Completing optimistically drops the row; an archived
 * (completed) row shows struck through. A checkbox click on any selected row in
 * a multi-selection completes or reopens the selected rows together.
 */
export const TaskRow = memo(function TaskRow({
  task,
  showSource,
  selected,
  onSelect,
  onCheckboxToggle,
  editHandlers,
  onOpen,
}: TaskRowProps): ReactElement {
  const editing = editHandlers !== undefined
  const noteLabel = useNoteLabel()
  const done = task.checked
  const label = task.text || 'Empty task'
  const selectFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (getIsComposing()) {
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    event.preventDefault()
    onSelect(task.taskId, {
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    })
  }
  const selectFromRow = (event: MouseEvent<HTMLDivElement>): void => {
    if (editing) {
      return
    }
    // Shift-click selects a range; stop the browser turning that into a text
    // selection across the rows.
    if (event.shiftKey) {
      event.preventDefault()
    }
    onSelect(task.taskId, event)
  }

  return (
    <div
      data-task-key={task.taskId}
      onClick={selectFromRow}
      style={{ minHeight: TASK_ROW_HEIGHT }}
      className={cn(
        'group/task flex items-start gap-3 border-b border-border bg-surface-canvas px-4 py-2 lg:px-12',
        !editing && 'cursor-pointer',
        selected
          ? 'bg-accent-soft ring-1 ring-inset ring-accent/20 dark:ring-accent/10'
          : 'hover:bg-surface-hover dark:bg-surface-canvas dark:hover:bg-surface-hover',
      )}
    >
      <button
        type="button"
        data-task-row
        aria-label={task.checked ? `Reopen: ${label}` : `Complete: ${label}`}
        onClick={(event) => {
          event.stopPropagation()
          onCheckboxToggle(task)
        }}
        // h-6 matches the text/editor's 24px line so the circle centers on
        // the first line (items-start keeps it there when a task wraps).
        className="flex h-6 shrink-0 items-center text-text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none"
      >
        {done ? (
          <CircleCheck aria-hidden className="size-[18px] text-accent" strokeWidth={2} />
        ) : (
          <Circle aria-hidden className="size-[18px]" strokeWidth={2} />
        )}
      </button>
      {editHandlers !== undefined ? (
        <TaskEditor task={task} {...editHandlers} />
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-pressed={selected}
          onKeyDown={selectFromKeyboard}
          className={cn(
            'min-w-0 flex-1 wrap-break-word text-left text-sm leading-6 text-text focus-visible:outline-none',
            task.checked && 'text-text-muted line-through',
          )}
        >
          <TaskText task={task} />
        </div>
      )}
      {showSource ? (
        <button
          type="button"
          disabled={editing}
          onClick={(event) => {
            event.stopPropagation()
            onOpen(task.notePath, event)
          }}
          className="flex h-6 shrink-0 items-center whitespace-nowrap text-xs text-text-muted transition-colors hover:text-accent focus-visible:text-accent focus-visible:outline-none"
        >
          {noteLabel({ path: task.notePath, title: task.noteTitle })}
        </button>
      ) : null}
    </div>
  )
})
