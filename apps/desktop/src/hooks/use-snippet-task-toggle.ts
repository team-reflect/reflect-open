import { useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SnippetTask, TaskLocator } from '@reflect/core'
import type { TaskClickHandler } from '@meowdown/react'
import { mutationKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

interface SnippetToggleInput {
  notePath: string
  locator: TaskLocator
  checked: boolean
}

/**
 * Write a backlink-snippet checkbox click through to the source note — old
 * Reflect's `toggleListChecked` behavior for checkboxes in a backlink's
 * context. Routes through `TaskService.toggleSnippetTask`: the same session-aware,
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
  const { tasks: taskService } = useCoreServices()

  const { mutate, isPending } = useMutation({
    mutationKey: mutationKeys.tasks.snippetToggle(graph?.root),
    // The service reports a failed write itself.
    mutationFn: ({ notePath: path, locator, checked }: SnippetToggleInput) => {
      return taskService.toggleSnippetTask(path, { locator, checked })
    },
  })

  const handler = useCallback<TaskClickHandler>(
    (payload) => {
      if (isPending) {
        return
      }
      // A drifted click answers null, already reported.
      const anchor = taskService.resolveSnippetTask(tasks, payload)
      if (anchor === null || anchor.locator === null) {
        return
      }
      mutate({ notePath, locator: anchor.locator, checked: anchor.checked })
    },
    [notePath, tasks, isPending, mutate, taskService],
  )

  return tasks.some((task) => task.locator !== null) ? handler : undefined
}
