import { groupTaskContexts, type OpenTask, type TaskGroup } from '@reflect/core'

/**
 * A row under a group header: a breadcrumb over a run of tasks that share an
 * outline context, or a task.
 */
export type TaskListRow =
  | {
      kind: 'breadcrumbs'
      key: string
      labels: readonly string[]
      /**
       * The tasks this breadcrumb labels.
       */
      tasks: readonly OpenTask[]
    }
  | {
      kind: 'task'
      key: string
      task: OpenTask
      /**
       * Show the source note: date buckets hold tasks from many notes.
       */
      showSource: boolean
    }

/**
 * One item of a flat Tasks list: a group header or a row.
 */
export type TaskListItem = { kind: 'header'; key: string; group: TaskGroup } | TaskListRow

/**
 * Task groups as one flat list.
 */
export interface TaskListItems {
  items: TaskListItem[]
  /**
   * Indexes of the header items, ascending.
   */
  headerIndexes: number[]
  /**
   * The index of each task's item, by `taskId`.
   */
  indexByTaskId: ReadonlyMap<string, number>
}

/**
 * Flattens task groups into one list: each group's header, then for each
 * outline context its breadcrumb (when it has a label) and its tasks.
 */
export function flattenTaskGroups(groups: readonly TaskGroup[]): TaskListItems {
  const items: TaskListItem[] = []
  const headerIndexes: number[] = []
  const indexByTaskId = new Map<string, number>()
  for (const group of groups) {
    const groupKey = group.kind === 'note' ? `note:${group.notePath}` : group.kind
    const showSource = group.kind !== 'note'
    headerIndexes.push(items.length)
    items.push({ kind: 'header', key: `header:${groupKey}`, group })
    for (const context of groupTaskContexts(group.tasks)) {
      if (context.visibleBreadcrumbs.length > 0) {
        items.push({
          kind: 'breadcrumbs',
          key: `breadcrumbs:${groupKey}:${context.tasks[0]!.taskId}`,
          labels: context.visibleBreadcrumbs,
          tasks: context.tasks,
        })
      }
      for (const task of context.tasks) {
        indexByTaskId.set(task.taskId, items.length)
        items.push({ kind: 'task', key: `task:${groupKey}:${task.taskId}`, task, showSource })
      }
    }
  }
  return { items, headerIndexes, indexByTaskId }
}
