import { useListSelection, type ListSelection } from '@/lib/selection/use-list-selection.ts'

/**
 * The Tasks view's multi-select (Plan 18, V1 parity). The implementation is the
 * generic {@link useListSelection} — selection over a flat, ordered list of
 * keys ({@link import('@reflect/core').getTaskKey}) — which the Tasks
 * and All Notes views share. This module keeps the Tasks-facing names so the
 * view code and its tests read in task terms.
 *
 * `isSoleSelected` is the state that mounts a task row's inline editor;
 * `activeKey()` is the row Return-to-add targets. Programmatic selection is
 * used by a task-context breadcrumb to select the rows it labels.
 */
export type TaskSelection = ListSelection

export function useTaskSelection(orderedKeys: readonly string[]): TaskSelection {
  return useListSelection(orderedKeys)
}
