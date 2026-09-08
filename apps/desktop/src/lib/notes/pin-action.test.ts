import { QueryClient } from '@tanstack/react-query'
import type { FilteredSearchHit, NoteListEntry, PinnedNote } from '@reflect/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query-client'
import { runPinAction } from './pin-action'

const toggleNotePinned = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
const unpinNote = vi.hoisted(() => vi.fn<() => Promise<void>>())
const fail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail })))
vi.mock('@/lib/note-pin', () => ({ toggleNotePinned, unpinNote }))
vi.mock('@/lib/operations', () => ({ startOperation }))

beforeEach(() => {
  vi.clearAllMocks()
  toggleNotePinned.mockResolvedValue(true)
  unpinNote.mockResolvedValue(undefined)
})

function setup() {
  const queryClient = new QueryClient()
  const input = { queryClient, root: '/g', generation: 7, path: 'notes/a.md', kind: 'toggle' as const }
  const shelfKey = queryKeys.index.pinnedNotes('/g')
  const desktopKey = queryKeys.index.allNotesWithTag('/g', null)
  const mobileKey = queryKeys.index.mobileAllNotesWithSearch('/g', { text: '' })
  const note: PinnedNote = { path: input.path, title: 'A', dailyDate: null, pinnedOrder: null }
  queryClient.setQueryData<PinnedNote[]>(shelfKey, [])
  queryClient.setQueryData<NoteListEntry[]>(desktopKey, [
    { path: input.path, title: 'A', snippet: '', tags: [], mtime: 0, isPinned: false },
  ])
  queryClient.setQueryData<FilteredSearchHit[]>(mobileKey, [
    { path: input.path, title: 'A', highlightedTitle: 'A', dailyDate: null, snippet: null, preview: '', mtime: 0, isPinned: false },
  ])
  return { input, queryClient, shelfKey, desktopKey, mobileKey, note }
}

describe('runPinAction', () => {
  it('updates the shelf and existing list markers before persistence resolves', async () => {
    const { input, queryClient, shelfKey, desktopKey, mobileKey, note } = setup()
    const write = Promise.withResolvers<boolean>()
    toggleNotePinned.mockReturnValueOnce(write.promise)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const action = runPinAction({ ...input, note })
    expect(queryClient.getQueryData(shelfKey)).toEqual([note])
    expect(queryClient.getQueryData<NoteListEntry[]>(desktopKey)?.[0]?.isPinned).toBe(true)
    expect(queryClient.getQueryData<FilteredSearchHit[]>(mobileKey)?.[0]?.isPinned).toBe(true)
    expect(toggleNotePinned).toHaveBeenCalledWith(input.path, 7)

    // A second entrypoint in this window must not issue a competing write.
    await runPinAction(input)
    expect(toggleNotePinned).toHaveBeenCalledTimes(1)
    write.resolve(true)
    await action
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('corrects a stale cache prediction from the file result', async () => {
    const { input, queryClient, shelfKey, mobileKey } = setup()
    toggleNotePinned.mockResolvedValueOnce(false)
    await runPinAction(input)
    expect(queryClient.getQueryData(shelfKey)).toEqual([])
    expect(queryClient.getQueryData<FilteredSearchHit[]>(mobileKey)?.[0]?.isPinned).toBe(false)
  })

  it('keeps explicit unpin directional even if the shelf is already empty', async () => {
    const { input, queryClient, shelfKey } = setup()
    await runPinAction({ ...input, kind: 'unpin' })
    expect(unpinNote).toHaveBeenCalledWith(input.path, 7)
    expect(toggleNotePinned).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(shelfKey)).toEqual([])
  })

  it('reconciles affected queries and reports a failed write once, allowing retry', async () => {
    const { input, queryClient, shelfKey, desktopKey, mobileKey } = setup()
    toggleNotePinned.mockRejectedValueOnce(new Error('disk full'))
    await runPinAction(input)
    for (const key of [shelfKey, desktopKey, mobileKey]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    }
    expect(startOperation).toHaveBeenCalledExactlyOnceWith('Updating pin')
    expect(fail).toHaveBeenCalledExactlyOnceWith('disk full')
    await runPinAction(input)
    expect(toggleNotePinned).toHaveBeenCalledTimes(2)
  })

  it('does not patch another graph or create uncached list queries', async () => {
    const { input, queryClient, note } = setup()
    const otherKey = queryKeys.index.pinnedNotes('/other')
    queryClient.setQueryData(otherKey, [note])
    await runPinAction(input)
    expect(queryClient.getQueryData(otherKey)).toEqual([note])
    expect(queryClient.getQueryData(queryKeys.index.allNotesWithTag('/g', 'uncached'))).toBeUndefined()
  })
})
