import { QueryClient } from '@tanstack/react-query'
import type { FilteredSearchHit, NoteListEntry, PinnedNote } from '@reflect/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query-client'
import { toggleNotePinned, unpinNote } from '@/lib/note-pin'

const readNoteSource = vi.hoisted(() => vi.fn(async () => '# A\n'))
const commitNoteFrontmatter = vi.hoisted(() => vi.fn<() => Promise<void>>())
const fail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail })))
vi.mock('@/lib/note-frontmatter', () => ({ readNoteSource, commitNoteFrontmatter }))
vi.mock('@/lib/operations', () => ({ startOperation }))

beforeEach(() => {
  vi.clearAllMocks()
  readNoteSource.mockReset().mockResolvedValue('# A\n')
  commitNoteFrontmatter.mockReset().mockResolvedValue(undefined)
})

function setup() {
  const queryClient = new QueryClient()
  const input = {
    queryClient,
    root: '/g',
    generation: 7,
    path: 'notes/a.md',
  }
  const shelfKey = queryKeys.index.pinnedNotes('/g')
  const desktopKey = queryKeys.index.allNotesWithTag('/g', null)
  const mobileKey = queryKeys.index.mobileAllNotesWithSearch('/g', { text: '' })
  const note: PinnedNote = { path: input.path, title: 'a', dailyDate: null, pinnedOrder: 1024 }
  queryClient.setQueryData<PinnedNote[]>(shelfKey, [])
  queryClient.setQueryData<NoteListEntry[]>(desktopKey, [
    { path: input.path, title: 'A', snippet: '', tags: [], mtime: 0, isPinned: false },
  ])
  queryClient.setQueryData<FilteredSearchHit[]>(mobileKey, [
    {
      path: input.path,
      title: 'A',
      highlightedTitle: 'A',
      dailyDate: null,
      snippet: null,
      preview: '',
      mtime: 0,
      isPinned: false,
    },
  ])
  return { input, queryClient, shelfKey, desktopKey, mobileKey, note }
}

describe('pin feedback', () => {
  it('updates the shelf and existing list markers before persistence resolves', async () => {
    const { input, queryClient, shelfKey, desktopKey, mobileKey, note } = setup()
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const action = toggleNotePinned(input)
    await vi.waitFor(() => expect(commitNoteFrontmatter).toHaveBeenCalledTimes(1))
    expect(queryClient.getQueryData(shelfKey)).toEqual([note])
    expect(queryClient.getQueryData<NoteListEntry[]>(desktopKey)?.[0]?.isPinned).toBe(true)
    expect(queryClient.getQueryData<FilteredSearchHit[]>(mobileKey)?.[0]?.isPinned).toBe(true)
    expect(commitNoteFrontmatter).toHaveBeenCalledWith(input.path, { pinned: 1024 }, 7)

    // A second entrypoint in this window must not issue a competing write.
    await toggleNotePinned(input)
    expect(commitNoteFrontmatter).toHaveBeenCalledTimes(1)
    write.resolve()
    await action
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('cancels old shelf and list requests before applying optimistic pin feedback', async () => {
    const { input, queryClient, shelfKey, desktopKey, mobileKey } = setup()
    const stale = [shelfKey, desktopKey, mobileKey].map((queryKey) => {
      const oldData = queryClient.getQueryData(queryKey)
      const response = Promise.withResolvers<unknown>()
      const fetch = queryClient
        .fetchQuery({ queryKey, queryFn: () => response.promise })
        .catch(() => null)
      return { response, fetch, oldData }
    })
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const action = toggleNotePinned(input)
    await vi.waitFor(() => expect(commitNoteFrontmatter).toHaveBeenCalledOnce())
    for (const request of stale) {
      request.response.resolve(request.oldData)
      await request.fetch
    }
    expect(queryClient.getQueryData<PinnedNote[]>(shelfKey)?.[0]?.path).toBe(input.path)
    expect(queryClient.getQueryData<NoteListEntry[]>(desktopKey)?.[0]?.isPinned).toBe(true)
    expect(queryClient.getQueryData<FilteredSearchHit[]>(mobileKey)?.[0]?.isPinned).toBe(true)
    write.resolve()
    await action
  })

  it('corrects a stale cache prediction from the file result', async () => {
    const { input, queryClient, shelfKey, mobileKey } = setup()
    readNoteSource.mockResolvedValueOnce('---\npinned: true\n---\n# A\n')
    await toggleNotePinned(input)
    expect(queryClient.getQueryData(shelfKey)).toEqual([])
    expect(queryClient.getQueryData<FilteredSearchHit[]>(mobileKey)?.[0]?.isPinned).toBe(false)
  })

  it('keeps explicit unpin directional even if the shelf is already empty', async () => {
    const { input, queryClient, shelfKey } = setup()
    await unpinNote(input)
    expect(commitNoteFrontmatter).toHaveBeenCalledWith(input.path, { pinned: false }, 7)
    expect(readNoteSource).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(shelfKey)).toEqual([])
  })

  it('reconciles affected queries and reports a failed write once, allowing retry', async () => {
    const { input, queryClient, shelfKey, desktopKey, mobileKey } = setup()
    commitNoteFrontmatter.mockRejectedValueOnce(new Error('disk full'))
    await toggleNotePinned(input)
    for (const key of [shelfKey, desktopKey, mobileKey]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    }
    expect(startOperation).toHaveBeenCalledExactlyOnceWith('Updating pin')
    expect(fail).toHaveBeenCalledExactlyOnceWith('disk full')
    await toggleNotePinned(input)
    expect(commitNoteFrontmatter).toHaveBeenCalledTimes(2)
  })

  it('does not patch another graph or create uncached list queries', async () => {
    const { input, queryClient, note } = setup()
    const otherKey = queryKeys.index.pinnedNotes('/other')
    queryClient.setQueryData(otherKey, [note])
    await toggleNotePinned(input)
    expect(queryClient.getQueryData(otherKey)).toEqual([note])
    expect(
      queryClient.getQueryData(queryKeys.index.allNotesWithTag('/g', 'uncached')),
    ).toBeUndefined()
  })
})
