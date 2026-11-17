import type { PinnedNoteRow } from '@reflect/types'
import { act } from '@/test-utils/act.ts'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { NoteActionsService } from '@reflect/core'
import {
  createTestDatabaseService,
  createTestCoreServices,
  type TestCoreServices,
  type TestOpenGraph,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useReorderPinnedNotes } from './use-reorder-pinned-notes.ts'

const GRAPH: TestOpenGraph = { generation: 7, root: '/graphs/personal' }

let core: TestCoreServices
let reorderPinnedNotes: MockInstance<NoteActionsService['reorderPinned']>

const NOTE_A = {
  dailyDate: null,
  path: 'a.md',
  title: 'A',
  pinnedOrder: 1024,
} satisfies PinnedNoteRow
const NOTE_B = {
  dailyDate: null,
  path: 'b.md',
  title: 'B',
  pinnedOrder: 2048,
} satisfies PinnedNoteRow
const NOTE_C = {
  dailyDate: null,
  path: 'c.md',
  title: 'C',
  pinnedOrder: 3072,
} satisfies PinnedNoteRow
const NOTES = [NOTE_A, NOTE_B, NOTE_C] as const

function renderReorder(pinned: readonly PinnedNoteRow[] = NOTES) {
  return renderHookInApp(
    (
      { pinned }: { pinned: readonly PinnedNoteRow[] } = {
        pinned: NOTES,
      },
    ) => useReorderPinnedNotes(pinned),
    { initialProps: { pinned }, core, graph: GRAPH },
  )
}

beforeEach(() => {
  core = createTestCoreServices({ database: createTestDatabaseService() })
  reorderPinnedNotes = vi.spyOn(core.noteActions, 'reorderPinned')
})

describe('useReorderPinnedNotes', () => {
  it('does nothing for a missing note or unchanged position', async () => {
    const hook = await renderReorder()

    await act(() => hook.result.current('missing.md', 'b.md'))
    await act(() => hook.result.current('a.md', 'a.md'))

    expect(reorderPinnedNotes).not.toHaveBeenCalled()
    expect(core.noteRows.get().size).toBe(0)
  })

  it('writes nothing without a graph', async () => {
    const hook = await renderReorder()

    await act(() => core.graphSession.setGraph(null))
    await act(() => hook.result.current('a.md', 'b.md'))

    await expect(reorderPinnedNotes.mock.results[0]?.value).resolves.toEqual([])
    expect(core.noteRows.getOverlaysOn(7).size).toBe(0)
  })

  it('records the moved order in the overlay at once and writes it', async () => {
    const hook = await renderReorder()

    await act(() => hook.result.current('a.md', 'b.md'))

    // A dropped between two neighbours takes the midpoint.
    expect(core.noteRows.get().get('a.md')).toEqual({ pinnedOrder: 2560 })
    expect(reorderPinnedNotes).toHaveBeenCalledExactlyOnceWith([{ ...NOTE_A, pinnedOrder: 2560 }])
  })

  it('renumbers the whole shelf when a neighbour carries no order', async () => {
    const bare = [
      { dailyDate: null, path: 'a.md', title: 'A', pinnedOrder: null },
      { dailyDate: null, path: 'b.md', title: 'B', pinnedOrder: null },
    ] satisfies PinnedNoteRow[]
    const hook = await renderReorder(bare)

    await act(() => hook.result.current('a.md', 'b.md'))

    expect(reorderPinnedNotes).toHaveBeenCalledExactlyOnceWith([
      { ...bare[1], pinnedOrder: 1024 },
      { ...bare[0], pinnedOrder: 2048 },
    ])
  })

  it('drops the overlay when the write fails, so the shelf shows the index again', async () => {
    vi.spyOn(core.noteDocuments, 'commitFrontmatter').mockRejectedValue(new Error('write failed'))
    const hook = await renderReorder()

    await act(() => hook.result.current('a.md', 'b.md'))

    await vi.waitFor(() => expect(core.noteRows.get().get('a.md')).toBeUndefined())
  })
})
