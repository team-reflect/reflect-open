import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedNote } from '@reflect/core'
import { queryKeys } from '@/lib/query-client'
import { deferred } from '@/test-utils/deferred'
import type { PinOrderWrite } from '@/lib/notes/pin-order'
import { useReorderPinnedNotes } from './use-reorder-pinned-notes'

const reorderPinnedNotes = vi.hoisted(() =>
  vi.fn<(writes: readonly PinOrderWrite[], generation: number) => Promise<void>>(),
)
vi.mock('@/lib/note-pin', () => ({ reorderPinnedNotes }))

const graphState: {
  graph: { generation: number; root: string } | null
} = vi.hoisted(() => ({ graph: { generation: 7, root: '/graphs/personal' } }))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => graphState }))

const NOTE_A = { dailyDate: null, path: 'a.md', title: 'A', pinnedOrder: 1024 } satisfies PinnedNote
const NOTE_B = { dailyDate: null, path: 'b.md', title: 'B', pinnedOrder: 2048 } satisfies PinnedNote
const NOTE_C = { dailyDate: null, path: 'c.md', title: 'C', pinnedOrder: 3072 } satisfies PinnedNote
const NOTES = [NOTE_A, NOTE_B, NOTE_C] as const
// A dropped between two neighbours takes the midpoint; dropped last it opens a
// fresh gap past the note it landed behind.
const FIRST_ORDER = [NOTE_B, { ...NOTE_A, pinnedOrder: 2560 }, NOTE_C]
const SECOND_ORDER = [NOTE_B, NOTE_C, { ...NOTE_A, pinnedOrder: 4096 }]
const THIRD_ORDER = [NOTE_C, { ...NOTE_A, pinnedOrder: 4096 }, { ...NOTE_B, pinnedOrder: 5120 }]

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function renderReorder(pinned: readonly PinnedNote[] = NOTES) {
  return renderHook(
    (
      { pinned }: { pinned: readonly PinnedNote[] } = {
        pinned: NOTES,
      },
    ) => useReorderPinnedNotes(pinned),
    { initialProps: { pinned }, wrapper },
  )
}

beforeEach(() => {
  graphState.graph = { generation: 7, root: '/graphs/personal' }
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Infinity },
    },
  })
  queryClient.setQueryData(queryKeys.index.pinnedNotes('/graphs/personal'), NOTES)
  reorderPinnedNotes.mockReset()
})

afterEach(async () => {
  queryClient.clear()
  await cleanup()
})

describe('useReorderPinnedNotes', () => {
  it('does nothing for a missing graph, missing note, or unchanged position', async () => {
    const hook = await renderReorder()

    await hook.act(() => hook.result.current('missing.md', 'b.md'))
    await hook.act(() => hook.result.current('a.md', 'a.md'))
    graphState.graph = null
    await hook.rerender({ pinned: NOTES })
    await hook.act(() => hook.result.current('a.md', 'b.md'))

    expect(reorderPinnedNotes).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(queryKeys.index.pinnedNotes('/graphs/personal'))).toEqual(NOTES)
  })

  it('updates optimistically and serializes disk writes after an earlier failure', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const third = deferred<void>()
    reorderPinnedNotes
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise)
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
    const hook = await renderReorder()

    await hook.act(() => hook.result.current('a.md', 'b.md'))
    expect(queryClient.getQueryData(queryKeys.index.pinnedNotes('/graphs/personal'))).toEqual(
      FIRST_ORDER,
    )
    await hook.rerender({ pinned: FIRST_ORDER })
    await hook.act(() => hook.result.current('a.md', 'c.md'))
    expect(queryClient.getQueryData(queryKeys.index.pinnedNotes('/graphs/personal'))).toEqual(
      SECOND_ORDER,
    )
    await hook.rerender({ pinned: SECOND_ORDER })
    await hook.act(() => hook.result.current('b.md', 'a.md'))
    expect(queryClient.getQueryData(queryKeys.index.pinnedNotes('/graphs/personal'))).toEqual(
      THIRD_ORDER,
    )
    expect(reorderPinnedNotes).toHaveBeenCalledTimes(1)

    first.resolve()
    await vi.waitFor(() => expect(reorderPinnedNotes).toHaveBeenCalledTimes(2))
    second.reject(new Error('second write failed'))
    await vi.waitFor(() => expect(reorderPinnedNotes).toHaveBeenCalledTimes(3))
    third.resolve()
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))

    expect(reorderPinnedNotes.mock.calls).toEqual([
      [[{ path: 'a.md', order: 2560 }], 7],
      [[{ path: 'a.md', order: 4096 }], 7],
      [[{ path: 'b.md', order: 5120 }], 7],
    ])
    expect(invalidateQueries).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(queryKeys.index.pinnedNotes('/graphs/personal'))).toEqual(
      THIRD_ORDER,
    )
  })

  it('renumbers the whole shelf when a neighbour carries no order', async () => {
    const bare = [
      { dailyDate: null, path: 'a.md', title: 'A' },
      { dailyDate: null, path: 'b.md', title: 'B' },
    ] satisfies PinnedNote[]
    queryClient.setQueryData(queryKeys.index.pinnedNotes('/graphs/personal'), bare)
    const hook = await renderReorder(bare)

    await hook.act(() => hook.result.current('a.md', 'b.md'))

    expect(reorderPinnedNotes).toHaveBeenCalledExactlyOnceWith(
      [
        { path: 'b.md', order: 1024 },
        { path: 'a.md', order: 2048 },
      ],
      7,
    )
  })

  it('refetches disk truth when the last outstanding reorder fails', async () => {
    const diskTruth = [NOTE_A, NOTE_C, NOTE_B]
    const readPinnedNotes = vi.fn<() => Promise<PinnedNote[]>>().mockResolvedValue(diskTruth)
    reorderPinnedNotes.mockRejectedValue(new Error('write failed'))
    const hook = await renderHook(
      () => {
        useQuery({
          queryFn: readPinnedNotes,
          queryKey: queryKeys.index.pinnedNotes('/graphs/personal'),
        })
        return useReorderPinnedNotes(NOTES)
      },
      { wrapper },
    )

    await hook.act(() => hook.result.current('a.md', 'b.md'))
    await vi.waitFor(() => expect(readPinnedNotes).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.index.pinnedNotes('/graphs/personal'))).toEqual(
        diskTruth,
      ),
    )
  })
})
