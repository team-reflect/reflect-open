import { errorMessage } from '../errors.ts'
import type { GraphSession } from '../graph/graph-session.ts'
import type { SnippetTask } from '../indexing/snippet-tasks.ts'
import type { TaskLocator } from '../markdown/index.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { Store } from '../store.ts'

/**
 * A click on the `index`th checkbox of a rendered snippet, as the view reports it.
 */
export interface SnippetTaskClick {
  index: number
  checked: boolean
  text: string
}

export function resolveSnippetTask(
  progress: ProgressPort,
  tasks: readonly SnippetTask[],
  click: SnippetTaskClick,
): SnippetTask | null {
  const anchor = tasks[click.index]
  if (anchor === undefined || anchor.checked !== click.checked || anchor.text !== click.text) {
    progress.fail('Updating task', 'The note has changed — try again in a moment.')
    return null
  }
  return anchor
}

export async function toggleSnippetTask(
  graphSession: Store<{ readonly session: GraphSession | null }>,
  progress: ProgressPort,
  toggleTask: (task: TaskLocator & { notePath: string }) => Promise<unknown>,
  notePath: string,
  task: { locator: TaskLocator; checked: boolean },
): Promise<void> {
  if (graphSession.get().session === null) {
    return
  }
  try {
    await toggleTask({ notePath, ...task.locator })
  } catch (cause) {
    progress.fail(task.checked ? 'Reopening task' : 'Completing task', errorMessage(cause))
    throw cause
  }
}
