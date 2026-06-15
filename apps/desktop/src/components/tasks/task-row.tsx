import type { ReactElement } from 'react'
import { CheckSquare, Square } from 'lucide-react'
import type { OpenTask } from '@reflect/core'
import { useCompleteTask } from '@/lib/tasks/use-complete-task'

interface TaskRowProps {
  task: OpenTask
  /** Show the source-note title — date buckets aggregate tasks from many notes. */
  showSource: boolean
  onOpen: (notePath: string) => void
}

/**
 * One open task in the Tasks view: a checkbox that completes the task (the
 * guarded write-back, Plan 18 PR3) and the task text, which opens the source
 * note. The checkbox is the arrow-navigable element (↑/↓ between rows, Space to
 * complete — see {@link TasksScreen}). Completing optimistically drops the row,
 * then the reindex confirms it; a failed write rolls the row back and surfaces
 * the reason (stale index, or the note is busy) via the operations toast.
 */
export function TaskRow({ task, showSource, onOpen }: TaskRowProps): ReactElement {
  const { complete, isPending } = useCompleteTask(task)
  const label = task.text || 'Empty task'

  return (
    <li className="flex items-start gap-2">
      <button
        type="button"
        data-task-row
        aria-label={`Complete: ${label}`}
        disabled={isPending}
        onClick={complete}
        className="mt-0.5 shrink-0 text-text-muted hover:text-text focus-visible:text-text focus-visible:outline-none"
      >
        {isPending ? (
          <CheckSquare aria-hidden className="size-4" strokeWidth={1.75} />
        ) : (
          <Square aria-hidden className="size-4" strokeWidth={1.75} />
        )}
      </button>
      <button
        type="button"
        onClick={() => onOpen(task.notePath)}
        className="min-w-0 flex-1 text-left text-sm text-text hover:underline focus-visible:underline focus-visible:outline-none"
      >
        <span className="break-words">{label}</span>
        {showSource ? <span className="ml-2 text-xs text-text-muted">{task.noteTitle}</span> : null}
      </button>
    </li>
  )
}
