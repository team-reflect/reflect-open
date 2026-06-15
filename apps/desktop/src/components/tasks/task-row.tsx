import { useState, type ReactElement } from 'react'
import { CheckSquare, Square } from 'lucide-react'
import { errorMessage, type OpenTask } from '@reflect/core'
import { completeTask } from '@/lib/note-task'
import { startOperation } from '@/lib/operations'
import { useGraph } from '@/providers/graph-provider'

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
 * complete — see {@link TasksScreen}); completing flips the file's marker, and
 * the row drops out once the reindex refreshes the list. A stale index refuses
 * loudly via the operations toast rather than writing the wrong line.
 */
export function TaskRow({ task, showSource, onOpen }: TaskRowProps): ReactElement {
  const { graph } = useGraph()
  const [completing, setCompleting] = useState(false)
  const label = task.text || 'Empty task'

  const onComplete = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined || completing) {
      return
    }
    setCompleting(true)
    try {
      await completeTask(task, generation)
      // Success: the reindex + index-query invalidation drops this row.
    } catch (cause) {
      setCompleting(false)
      startOperation('Completing task').fail(errorMessage(cause))
    }
  }

  return (
    <li className="flex items-start gap-2">
      <button
        type="button"
        data-task-row
        aria-label={`Complete: ${label}`}
        disabled={completing}
        onClick={() => void onComplete()}
        className="mt-0.5 shrink-0 text-text-muted hover:text-text focus-visible:text-text focus-visible:outline-none"
      >
        {completing ? (
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
