import type { KeyboardEvent, MouseEvent, ReactElement } from 'react'
import { Circle, CircleCheck } from 'lucide-react'
import { displayNoteTitle, type Task } from '@reflect/core'
import { getIsComposing } from '@meowdown/core'
import { formatDayLabel } from '@/lib/dates.ts'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import type { TaskCommands } from '@/lib/tasks/use-task-commands.ts'
import { TaskEditor } from './task-editor.tsx'
import { TaskText } from './task-text.tsx'

interface TaskRowProps {
  task: Task
  /** Show the source-note date — date buckets aggregate tasks from many notes. */
  showSource: boolean
  /** Whether this row is part of the current multi-selection (Plan 18). */
  selected: boolean
  /** Whether this row is the sole selection — it shows the inline editor. */
  editing: boolean
  /** Select the row, honoring ⌘/Ctrl (toggle) and Shift (range) modifiers. */
  onSelect: (event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void
  /** The view's task commands, which the inline editor binds to its keys. */
  commands: TaskCommands
  onOpen: (notePath: string, event?: ModClickEvent) => void
}

/**
 * One task row in the Tasks view (V1 design): a circle checkbox that toggles
 * the task, the task content with inline date
 * and link chips ({@link TaskText}), and a source-note link on the right.
 * Clicking the row body **selects** it (V1's
 * multi-select); a plain click selects exclusively, ⌘/Ctrl toggles, Shift
 * extends a range. A completed row shows struck through until archived. A checkbox click on any selected row in
 * a multi-selection completes or reopens the selected rows together.
 */
export function TaskRow({
  task,
  showSource,
  selected,
  editing,
  onSelect,
  commands,
  onOpen,
}: TaskRowProps): ReactElement {
  const { settings } = useSettings()
  const done = task.checked
  const label = task.displayText || 'Empty task'
  const selectFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (getIsComposing()) {
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    event.preventDefault()
    onSelect({ metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey })
  }
  const selectFromRow = (event: MouseEvent<HTMLLIElement>): void => {
    if (editing) {
      return
    }
    // Shift-click selects a range; stop the browser turning that into a text
    // selection across the rows.
    if (event.shiftKey) {
      event.preventDefault()
    }
    onSelect(event)
  }

  return (
    <li
      data-task-key={task.key}
      onClick={selectFromRow}
      className={cn(
        'group/task flex min-h-10 items-start gap-3 border-b border-border bg-surface px-4 py-2 lg:px-12',
        !editing && 'cursor-pointer',
        selected
          ? 'bg-accent-soft ring-1 ring-inset ring-accent/20 dark:ring-accent/10'
          : 'hover:bg-surface-hover dark:bg-surface dark:hover:bg-surface-hover',
      )}
    >
      <button
        type="button"
        data-task-row
        aria-label={task.checked ? `Reopen: ${label}` : `Complete: ${label}`}
        onClick={(event) => {
          event.stopPropagation()
          commands.check(task)
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
      {editing ? (
        <TaskEditor task={task} commands={commands} />
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-pressed={selected}
          aria-label={label}
          onKeyDown={selectFromKeyboard}
          className={cn(
            'min-w-0 flex-1 break-words text-left text-sm leading-6 text-text focus-visible:outline-none',
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
          {task.dailyDate !== null
            ? formatDayLabel(task.dailyDate, settings.dateFormat)
            : displayNoteTitle(task.noteTitle)}
        </button>
      ) : null}
    </li>
  )
}
