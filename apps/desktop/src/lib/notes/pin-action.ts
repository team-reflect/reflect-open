import {
  errorMessage,
  type FilteredSearchHit,
  type NoteListEntry,
  type NoteRow,
  type PinnedNote,
} from '@reflect/core'
import type { QueryClient } from '@tanstack/react-query'
import { toggleNotePinned, unpinNote } from '@/lib/note-pin'
import { startOperation } from '@/lib/operations'
import { queryKeys } from '@/lib/query-client'
import {
  insertPinnedNote,
  invalidatePinnedNotesCache,
  pinnedNoteFor,
  updatePinnedNotesCache,
} from './pinned-notes-cache'

interface PinActionInput {
  queryClient: QueryClient
  root: string
  generation: number
  path: string
  kind: 'toggle' | 'unpin'
  note?: PinnedNote
}

const pendingPins = new Set<string>()

function applyPinnedState(input: PinActionInput, note: PinnedNote, isPinned: boolean): void {
  const { queryClient, root, path } = input
  updatePinnedNotesCache(queryClient, root, (current = []) => {
    if (!isPinned) {
      return current.filter((entry) => entry.path !== path)
    }
    return current.some((entry) => entry.path === path) ? current : insertPinnedNote(current, note)
  })
  queryClient.setQueriesData<NoteListEntry[]>(
    { queryKey: queryKeys.index.allNotes(root) },
    (rows) => rows?.map((row) => (row.path === path ? { ...row, isPinned } : row)),
  )
  queryClient.setQueriesData<FilteredSearchHit[]>(
    { queryKey: queryKeys.index.mobileAllNotes(root) },
    (rows) => rows?.map((row) => (row.path === path ? { ...row, isPinned } : row)),
  )
}

/** Update pin feedback immediately, then persist through the canonical frontmatter path. */
export async function runPinAction(input: PinActionInput): Promise<void> {
  const { queryClient, root, generation, path, kind } = input
  const key = JSON.stringify([root, generation, path])
  if (pendingPins.has(key)) {
    return
  }
  pendingPins.add(key)
  try {
    const previous = queryClient
      .getQueryData<PinnedNote[]>(queryKeys.index.pinnedNotes(root))
      ?.find((note) => note.path === path)
    const row = queryClient.getQueryData<NoteRow | null>(queryKeys.index.note(root, path))
    const preview = input.note ?? previous ?? pinnedNoteFor(path, row ?? null)
    const predicted = kind === 'unpin' ? false : previous === undefined
    applyPinnedState(input, preview, predicted)

    let actual: boolean
    if (kind === 'unpin') {
      await unpinNote(path, generation)
      actual = false
    } else {
      actual = await toggleNotePinned(path, generation)
    }
    if (actual !== predicted) {
      applyPinnedState(input, preview, actual)
    }
  } catch (cause) {
    invalidatePinnedNotesCache(queryClient, root)
    void queryClient.invalidateQueries({ queryKey: queryKeys.index.allNotes(root) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.index.mobileAllNotes(root) })
    startOperation('Updating pin').fail(errorMessage(cause))
  } finally {
    pendingPins.delete(key)
  }
}
