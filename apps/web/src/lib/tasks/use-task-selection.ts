import { useListSelection, type ListSelection } from '@/lib/selection/use-list-selection.ts'

/**
 * Multi-select over a flat, ordered list of task keys
 * ({@link import('@reflect/core').getTaskKey}), built on the generic
 * {@link useListSelection}.
 *
 * `isSoleSelected` is the state that mounts a task row's inline editor;
 * `activeKey()` is the row Return-to-add targets. Programmatic selection is
 * used by a task-context breadcrumb to select the rows it labels.
 */
export type TaskSelection = ListSelection

export function useTaskSelection(orderedKeys: readonly string[]): TaskSelection {
  return useListSelection(orderedKeys)
}
