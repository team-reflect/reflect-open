import { act } from '@/test-utils/act.ts'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { IndexQueryService, NoteRow } from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useNoteRow } from './use-note-row.ts'

const GENERATION = 5

let core: TestCoreServices
let getNote: MockInstance<IndexQueryService['getNote']>

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md',
    title: 'A',
    dailyDate: null,
    isPrivate: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

/**
 * Render the hook for `notes/a.md` in the graph `/g`.
 */
async function mount() {
  return await renderHookInApp(() => useNoteRow('notes/a.md'), {
    core,
    graph: { root: '/g', name: 'g', generation: GENERATION },
  })
}

beforeEach(() => {
  core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  getNote = vi.spyOn(core.indexQuery, 'getNote')
})

describe('useNoteRow', () => {
  it('returns the index row', async () => {
    getNote.mockResolvedValue(noteRow({ gistUrl: 'from-index' }))
    const { result } = await mount()
    await vi.waitFor(() => expect(result.current?.gistUrl).toBe('from-index'))
  })

  it('overlays a freshly-written value over a lagging index row', async () => {
    getNote.mockResolvedValue(noteRow({ gistUrl: null })) // index hasn't seen the publish yet
    const { result } = await mount()
    await vi.waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current?.gistUrl).toBeNull()

    await act(() => core.noteRows.setOverlay('notes/a.md', GENERATION, { gistUrl: 'pending' }))
    await vi.waitFor(() => expect(result.current?.gistUrl).toBe('pending'))
  })

  it('retires the overlay once the index row catches up to it', async () => {
    core.noteRows.setOverlay('notes/a.md', GENERATION, { gistUrl: 'u' })
    getNote.mockResolvedValue(noteRow({ gistUrl: 'u' })) // index already agrees
    const { result } = await mount()

    await vi.waitFor(() => expect(result.current?.gistUrl).toBe('u'))
    await vi.waitFor(() => expect(core.noteRows.getOverlay('notes/a.md')).toBeNull())
  })
})
