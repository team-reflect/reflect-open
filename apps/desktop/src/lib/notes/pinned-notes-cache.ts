import type { QueryClient } from '@tanstack/react-query'
import { dateFromDailyPath, type NoteRow, type PinnedNote } from '@reflect/core'
import { queryKeys } from '@/lib/query-client'

/**
 * Apply an optimistic update to the pinned-notes cache. The markdown/index
 * pipeline remains source of truth; this only hides local write latency.
 */
export function updatePinnedNotesCache(
  queryClient: QueryClient,
  graphRoot: string,
  updater: (current: PinnedNote[] | undefined) => PinnedNote[] | undefined,
): void {
  queryClient.setQueryData<PinnedNote[]>(queryKeys.index.pinnedNotes(graphRoot), updater)
}

/** Refetch pinned notes after a failed write so the sidebar reconciles with the index. */
export function invalidatePinnedNotesCache(queryClient: QueryClient, graphRoot: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.index.pinnedNotes(graphRoot) })
}

function titleFromPath(path: string): string {
  const name = path.split('/').at(-1) ?? path
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

/** Build a shelf preview without waiting for the index. */
export function pinnedNoteFor(path: string, row: NoteRow | null): PinnedNote {
  return {
    path,
    title: row?.title ?? titleFromPath(path),
    dailyDate: row?.dailyDate ?? dateFromDailyPath(path),
    pinnedOrder: null,
  }
}

function comparePinnedNote(left: PinnedNote, right: PinnedNote): number {
  const titleOrder = left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
  return titleOrder === 0 ? left.path.localeCompare(right.path) : titleOrder
}

/** Keep explicit pin order, then sort unordered pins by title. */
export function insertPinnedNote(pinned: readonly PinnedNote[], note: PinnedNote): PinnedNote[] {
  const existing = pinned.filter((pinnedNote) => pinnedNote.path !== note.path)
  const ordered = existing.filter(
    (pinnedNote) => pinnedNote.pinnedOrder !== null && pinnedNote.pinnedOrder !== undefined,
  )
  const bare = [
    ...existing.filter(
      (pinnedNote) => pinnedNote.pinnedOrder === null || pinnedNote.pinnedOrder === undefined,
    ),
    note,
  ]
  bare.sort(comparePinnedNote)
  return [...ordered, ...bare]
}
