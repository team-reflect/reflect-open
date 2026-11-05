import { getTaskKey, groupTaskContexts, type OpenTask, type TaskGroup } from '@reflect/core'

/**
 * One row of a virtualized Tasks list: a group header, a breadcrumb over a run
 * of tasks that share an outline context, or a task.
 */
export type TaskListItem =
  | { kind: 'header'; key: string; group: TaskGroup }
  | {
      kind: 'breadcrumbs'
      key: string
      labels: readonly string[]
      /**
       * The keys (`getTaskKey`) of the tasks this breadcrumb labels.
       */
      taskKeys: readonly string[]
    }
  | {
      kind: 'task'
      key: string
      task: OpenTask
      /**
       * Show the source note: date buckets aggregate tasks from many notes.
       */
      showSource: boolean
      /**
       * The last row of its group.
       */
      groupEnd: boolean
    }

/**
 * The groups of a Tasks list flattened for a virtualizer.
 */
export interface TaskListItems {
  items: TaskListItem[]
  /**
   * Indexes of the header items, ascending.
   */
  headerIndexes: number[]
  /**
   * Item index of each task, by `getTaskKey`.
   */
  indexByTaskKey: ReadonlyMap<string, number>
}

/**
 * Flattens task groups into one list of rows: each group's header, then for
 * each outline context its breadcrumb (when it has a label) and its tasks.
 */
export function flattenTaskGroups(groups: readonly TaskGroup[]): TaskListItems {
  const items: TaskListItem[] = []
  const headerIndexes: number[] = []
  const indexByTaskKey = new Map<string, number>()
  for (const group of groups) {
    const groupKey = group.kind === 'note' ? `note:${group.notePath}` : group.kind
    const showSource = group.kind !== 'note'
    headerIndexes.push(items.length)
    items.push({ kind: 'header', key: `header:${groupKey}`, group })
    for (const context of groupTaskContexts(group.tasks)) {
      const taskKeys = context.tasks.map(getTaskKey)
      if (context.visibleBreadcrumbs.length > 0) {
        items.push({
          kind: 'breadcrumbs',
          key: `breadcrumbs:${groupKey}:${taskKeys[0]}`,
          labels: context.visibleBreadcrumbs,
          taskKeys,
        })
      }
      for (const [i, task] of context.tasks.entries()) {
        const taskKey = taskKeys[i]!
        indexByTaskKey.set(taskKey, items.length)
        items.push({
          kind: 'task',
          key: `task:${groupKey}:${taskKey}`,
          task,
          showSource,
          groupEnd: false,
        })
      }
    }
    const last = items.at(-1)
    if (last?.kind === 'task') {
      last.groupEnd = true
    }
  }
  return { items, headerIndexes, indexByTaskKey }
}
