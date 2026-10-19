import { act } from '@/test-utils/act.ts'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { NoteActionsService, PinnedNote } from '@reflect/core'
import {
  createTestCoreServices,
  type TestCoreServices,
  type TestOpenGraph,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useReorderPinnedNotes } from './use-reorder-pinned-notes.ts'

const GRAPH: TestOpenGraph = { generation: 7, root: '/graphs/personal' }

let app: TestCoreServices
let reorderPinnedNotes: MockInstance<NoteActionsService['reorderPinned']>

const NOTE_A = { dailyDate: null, path: 'a.md', title: 'A', pinnedOrder: 1024 } satisfies PinnedNote
const NOTE_B = { dailyDate: null, path: 'b.md', title: 'B', pinnedOrder: 2048 } satisfies PinnedNote
const NOTE_C = { dailyDate: null, path: 'c.md', title: 'C', pinnedOrder: 3072 } satisfies PinnedNote
const NOTES = [NOTE_A, NOTE_B, NOTE_C] as const

function renderReorder(pinned: readonly PinnedNote[] = NOTES) {
  return renderHookInApp(
    (
      { pinned }: { pinned: readonly PinnedNote[] } = {
        pinned: NOTES,
      },
    ) => useReorderPinnedNotes(pinned),
    { initialProps: { pinned }, app, graph: GRAPH },
  )
}

beforeEach(() => {
  app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  reorderPinnedNotes = vi.spyOn(app.noteActions, 'reorderPinned')
})

describe('useReorderPinnedNotes', () => {
  it('does nothing for a missing note or unchanged position', async () => {
    const hook = await renderReorder()

    await act(() => hook.result.current('missing.md', 'b.md'))
    await act(() => hook.result.current('a.md', 'a.md'))

    expect(reorderPinnedNotes).not.toHaveBeenCalled()
    expect(app.noteRows.getOverlays().size).toBe(0)
  })

  it('writes nothing without a graph', async () => {
    const hook = await renderReorder()

    await act(() => app.graphSession.setGraph(null))
    await act(() => hook.result.current('a.md', 'b.md'))

    await expect(reorderPinnedNotes.mock.results[0]?.value).resolves.toEqual([])
    expect(app.noteRows.getOverlaysOn(7).size).toBe(0)
  })

  it('records the moved order in the overlay at once and writes it', async () => {
    const hook = await renderReorder()

    await act(() => hook.result.current('a.md', 'b.md'))

    // A dropped between two neighbours takes the midpoint.
    expect(app.noteRows.getOverlay('a.md')).toEqual({ pinnedOrder: 2560 })
    expect(reorderPinnedNotes).toHaveBeenCalledExactlyOnceWith([{ ...NOTE_A, pinnedOrder: 2560 }])
  })

  it('renumbers the whole shelf when a neighbour carries no order', async () => {
    const bare = [
      { dailyDate: null, path: 'a.md', title: 'A' },
      { dailyDate: null, path: 'b.md', title: 'B' },
    ] satisfies PinnedNote[]
    const hook = await renderReorder(bare)

    await act(() => hook.result.current('a.md', 'b.md'))

    expect(reorderPinnedNotes).toHaveBeenCalledExactlyOnceWith([
      { ...bare[1], pinnedOrder: 1024 },
      { ...bare[0], pinnedOrder: 2048 },
    ])
  })

  it('drops the overlay when the write fails, so the shelf shows the index again', async () => {
    vi.spyOn(app.noteDocuments, 'commitFrontmatter').mockRejectedValue(new Error('write failed'))
    const hook = await renderReorder()

    await act(() => hook.result.current('a.md', 'b.md'))

    await vi.waitFor(() => expect(app.noteRows.getOverlay('a.md')).toBeNull())
  })
})
