import {
  errorMessage,
  isPinned,
  parseNote,
  type FilteredSearchHit,
  type NoteListEntry,
  type NoteRow,
  type PinnedNote,
} from '@reflect/core'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter'
import { startOperation } from '@/lib/operations'
import { queryKeys } from '@/lib/query-client'
import {
  insertPinnedNote,
  invalidatePinnedNotesCache,
  pinnedNoteFor,
  updatePinnedNotesCache,
} from './notes/pinned-notes-cache'
import { nextPinOrder, type PinOrderWrite } from './notes/pin-order'
import type { NoteActionInput } from './notes/types'

/** Toggle pin with shared optimistic feedback and save-error reporting. Markdown owns the final state. */
export async function toggleNotePinned(input: NoteActionInput): Promise<void> {
  await updatePin(input, 'toggle')
}

/** Remove a pin directionally, even when the cached shelf is stale. */
export async function unpinNote(input: NoteActionInput): Promise<void> {
  await updatePin(input, 'unpin')
}

const pendingPins = new Set<string>()

function applyPinnedState(input: NoteActionInput, note: PinnedNote, isPinned: boolean): void {
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

async function updatePin(input: NoteActionInput, kind: 'toggle' | 'unpin'): Promise<void> {
  const { queryClient, root, generation, path } = input
  const key = JSON.stringify([root, generation, path])
  if (pendingPins.has(key)) {
    return
  }
  pendingPins.add(key)
  try {
    await Promise.all([
      queryClient.cancelQueries({ queryKey: queryKeys.index.pinnedNotes(root) }),
      queryClient.cancelQueries({ queryKey: queryKeys.index.allNotes(root) }),
      queryClient.cancelQueries({ queryKey: queryKeys.index.mobileAllNotes(root) }),
    ])
    const shelf = queryClient.getQueryData<PinnedNote[]>(queryKeys.index.pinnedNotes(root))
    const previous = shelf?.find((note) => note.path === path)
    const row = queryClient.getQueryData<NoteRow | null>(queryKeys.index.note(root, path))
    // A shelf that has never loaded can't say what the next order is. `true`
    // still pins; the note sorts last until a reorder numbers it.
    const pin = shelf === undefined ? true : nextPinOrder(shelf)
    const preview = previous ?? {
      ...pinnedNoteFor(path, row ?? null),
      pinnedOrder: pin === true ? null : pin,
    }
    const predicted = kind === 'unpin' ? false : previous === undefined
    applyPinnedState(input, preview, predicted)

    const actual =
      kind === 'unpin'
        ? false
        : !isPinned(parseNote({ path, source: await readNoteSource(path) }).frontmatter)
    await commitNoteFrontmatter(path, { pinned: actual ? pin : false }, generation)
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

export async function reorderPinnedNotes(
  writes: readonly PinOrderWrite[],
  generation: number,
): Promise<void> {
  await Promise.all(
    writes.map((write) => commitNoteFrontmatter(write.path, { pinned: write.order }, generation)),
  )
}
