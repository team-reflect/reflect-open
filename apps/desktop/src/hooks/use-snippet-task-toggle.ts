import { useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { errorMessage, type SnippetTask } from '@reflect/core'
import type { TaskClickHandler, TaskClickPayload } from '@meowdown/react'
import { toggleTask } from '@/lib/note-task'
import { startOperation } from '@/lib/operations'
import { useGraph } from '@/providers/graph-provider'

interface SnippetToggleInput {
  notePath: string
  task: SnippetTask
  generation: number
}

/**
 * The clicked checkbox against our anchor for the same index. The view and the
 * anchors enumerate the same markdown independently (meowdown's render walk vs
 * the core's parse — see `extractSnippetTasks`), so index, state, and the
 * item's own first-line text must all agree; any mismatch means the two walks
 * drifted, and a toggle would hit the wrong task. `null` refuses.
 */
function anchorFor(
  tasks: readonly SnippetTask[],
  payload: TaskClickPayload,
): SnippetTask | null {
  const anchor = tasks[payload.index]
  if (anchor === undefined || anchor.checked !== payload.checked || anchor.text !== payload.text) {
    return null
  }
  return anchor
}

/**
 * Write a backlink-snippet checkbox click through to the source note — old
 * Reflect's `toggleListChecked` behavior for checkboxes in a backlink's
 * context. Routes through {@link toggleTask}: the same session-aware,
 * per-note-serialized, staleness-guarded path the Tasks view uses, so an open
 * source note keeps its live buffer and a drifted note refuses instead of
 * toggling the wrong line. Only round `+ [ ]` Reflect tasks toggle (V1's
 * contextHtml checkboxes were Reflect tasks); a square GFM box is plain
 * markdown, outside the tasks projection, and stays read-only. There is no
 * optimistic flip: the write reindexes the source, which refreshes the
 * backlinks query and re-renders the snippet with the new marker.
 */
export function useSnippetTaskToggle(
  notePath: string,
  tasks: readonly SnippetTask[],
): TaskClickHandler | undefined {
  const { graph } = useGraph()

  const mutation = useMutation({
    mutationFn: ({ notePath: path, task, generation }: SnippetToggleInput) =>
      toggleTask({ notePath: path, markerOffset: task.markerOffset, raw: task.raw }, generation),
    onError: (cause, { task }) => {
      startOperation(task.checked ? 'Reopening task' : 'Completing task').fail(errorMessage(cause))
    },
  })
  const { mutate, isPending } = mutation

  const generation = graph?.generation
  const handler = useCallback<TaskClickHandler>(
    (payload) => {
      if (generation === undefined || isPending) {
        return
      }
      const anchor = anchorFor(tasks, payload)
      if (anchor === null) {
        startOperation('Updating task').fail('The note has changed — try again in a moment.')
        return
      }
      if (!anchor.round) {
        return
      }
      mutate({ notePath, task: anchor, generation })
    },
    [notePath, tasks, generation, isPending, mutate],
  )

  return tasks.some((task) => task.round) ? handler : undefined
}
