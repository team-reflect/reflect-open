import type { ReactElement } from 'react'
import { CheckSquare, Square } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { errorMessage, type OpenTask } from '@reflect/core'
import { toggleTask } from '@/lib/note-task'
import { startOperation } from '@/lib/operations'
import { tasksQueryKey } from '@/lib/tasks/tasks-query'
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
 * complete — see {@link TasksScreen}). Completing optimistically drops the row,
 * then the reindex confirms it; a failed write rolls the row back and surfaces
 * the reason (stale index, or the note is busy) via the operations toast.
 */
export function TaskRow({ task, showSource, onOpen }: TaskRowProps): ReactElement {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const key = tasksQueryKey(graph?.root)
  const label = task.text || 'Empty task'

  const mutation = useMutation({
    mutationFn: (generation: number) => toggleTask(task, generation),
    onMutate: async () => {
      // Drop the row now so completing feels instant; the reindex reconciles.
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<OpenTask[]>(key)
      queryClient.setQueryData<OpenTask[]>(key, (rows) =>
        rows?.filter(
          (row) => row.notePath !== task.notePath || row.markerOffset !== task.markerOffset,
        ),
      )
      return { previous }
    },
    onError: (cause, _generation, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(key, context.previous)
      }
      startOperation('Completing task').fail(errorMessage(cause))
    },
  })

  const onComplete = (): void => {
    const generation = graph?.generation
    if (generation === undefined || mutation.isPending) {
      return
    }
    mutation.mutate(generation)
  }

  return (
    <li className="flex items-start gap-2">
      <button
        type="button"
        data-task-row
        aria-label={`Complete: ${label}`}
        disabled={mutation.isPending}
        onClick={onComplete}
        className="mt-0.5 shrink-0 text-text-muted hover:text-text focus-visible:text-text focus-visible:outline-none"
      >
        {mutation.isPending ? (
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
