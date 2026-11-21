import type { RecentGraph } from '@reflect/core'

/**
 * Order the graph menu and its numbered slots (Cmd+1..9) alphabetically by
 * graph name, so a number maps to a predictable graph instead of following the
 * recents list, which reshuffles by most-recently-used. Case-insensitive, with
 * the root path as a stable tiebreak. Roots that collate as equal but differ in
 * Unicode encoding fall back to an exact comparison.
 */
export function sortGraphsByName(recents: readonly RecentGraph[]): RecentGraph[] {
  return [...recents].sort((left, right) => {
    return (
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
      left.root.localeCompare(right.root) ||
      (left.root < right.root ? -1 : left.root > right.root ? 1 : 0)
    )
  })
}
