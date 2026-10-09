import { useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { errorMessage, type SnippetTask, type TaskLocator } from '@reflect/core'
import type { TaskClickHandler, TaskClickPayload } from '@meowdown/react'
import { writeTask } from '@/lib/note-task.ts'
import { startOperation } from '@/lib/operations.ts'
import { mutationKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

interface SnippetToggleInput {
  notePath: string
  locator: TaskLocator
  checked: boolean
  generation: number
}

/**
 * The clicked checkbox against our anchor for the same index. The view and the
 * anchors enumerate the same markdown independently (meowdown's render walk vs
 * the core's parse — see `extractSnippetTasks`), so index, state, and the
 * item's own first-line text must all agree; any mismatch means the two walks
 * drifted, and a toggle would hit the wrong task. `null` refuses.
 */
function anchorFor(tasks: readonly SnippetTask[], payload: TaskClickPayload): SnippetTask | null {
  const anchor = tasks[payload.index]
  if (anchor === undefined || anchor.checked !== payload.checked || anchor.text !== payload.text) {
    return null
  }
  return anchor
}

/**
 * Write a backlink-snippet checkbox click through to the source note — old
 * Reflect's `toggleListChecked` behavior for checkboxes in a backlink's
 * context. Routes through {@link writeTask}: the same session-aware,
 * per-note-serialized, staleness-guarded path the Tasks view uses, so an open
 * source note keeps its live buffer and a drifted note refuses instead of
 * toggling the wrong task. Only round `+ [ ]` Reflect tasks carry a locator
 * (V1's contextHtml checkboxes were Reflect tasks); a square GFM box is plain
 * markdown, outside the tasks projection, and stays read-only. There is no
 * optimistic flip: the write reindexes the source, which refreshes the
 * backlinks query and re-renders the snippet with the new marker.
 */
export function useSnippetTaskToggle(
  notePath: string,
  tasks: readonly SnippetTask[],
): TaskClickHandler | undefined {
  const { graph } = useGraph()

  const { mutate, isPending } = useMutation({
    mutationKey: mutationKeys.tasks.snippetToggle(graph?.root),
    mutationFn: ({ notePath: path, locator, generation }: SnippetToggleInput) =>
      writeTask({ notePath: path, ...locator }, [{ kind: 'toggle' }], generation),
    onError: (cause, { checked }) => {
      startOperation(checked ? 'Reopening task' : 'Completing task').fail(errorMessage(cause))
    },
  })

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
      if (anchor.locator === null) {
        return
      }
      mutate({ notePath, locator: anchor.locator, checked: anchor.checked, generation })
    },
    [notePath, tasks, generation, isPending, mutate],
  )

  return tasks.some((task) => task.locator !== null) ? handler : undefined
}
