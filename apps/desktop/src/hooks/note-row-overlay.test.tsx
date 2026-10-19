import { act } from '@/test-utils/act.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NoteRow } from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useNoteRowOverlay } from './note-row-overlay.ts'

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

const URL = 'https://gist.github.com/alex/g1'
const GEN = 1

let app: TestCoreServices

/**
 * Render the overlay hook for `path` over the shared `app`.
 */
async function mount(path: string) {
  return await renderHookInApp(() => useNoteRowOverlay(path), { app })
}

beforeEach(() => {
  app = createTestCoreServices({ database: createWasmTestDatabaseService() })
})

describe('useNoteRowOverlay', () => {
  it('reflects a set overlay and scopes it to the path', async () => {
    const { result } = await mount('notes/a.md')
    const other = await mount('notes/b.md')
    expect(result.current).toBeNull()

    await act(() => app.noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL }))
    expect(result.current?.gistUrl).toBe(URL)
    expect(other.result.current).toBeNull()
  })

  it('retires overlay fields independently as the index catches up', async () => {
    const { result } = await mount('notes/a.md')
    await act(() => app.noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL, gistStale: false }))

    await act(() => {
      app.noteRows.reconcile('notes/a.md', noteRow({ gistUrl: URL, gistStale: true }))
    })
    expect(result.current).toEqual({ gistStale: false })

    await act(() => {
      app.noteRows.reconcile('notes/a.md', noteRow({ gistUrl: URL, gistStale: false }))
    })
    expect(result.current).toBeNull()
  })
})

describe('reconcileNoteRowOverlay', () => {
  it('holds the overlay while the index still lags, retires it once they agree', async () => {
    const { result } = await mount('notes/a.md')
    await act(() => app.noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL }))

    await act(() => app.noteRows.reconcile('notes/a.md', noteRow({ gistUrl: null })))
    expect(result.current?.gistUrl).toBe(URL) // index hasn't caught up

    await act(() => app.noteRows.reconcile('notes/a.md', noteRow({ gistUrl: URL })))
    expect(result.current).toBeNull() // index agrees → retired
  })

  it('holds the overlay against a null row (nothing to compare yet)', async () => {
    const { result } = await mount('notes/a.md')
    await act(() => app.noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL }))
    await act(() => app.noteRows.reconcile('notes/a.md', null))
    expect(result.current?.gistUrl).toBe(URL)
  })
})

describe('resetNoteRowOverlays', () => {
  it('drops every overlay (e.g. on a graph switch)', async () => {
    const { result } = await mount('notes/a.md')
    await act(() => app.noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL }))
    expect(result.current?.gistUrl).toBe(URL)

    await act(() => app.noteRows.reset())
    expect(result.current).toBeNull()
  })

  it('hides the overlays of a graph once another graph opens', async () => {
    const { result } = await mount('notes/a.md')
    await act(() => app.noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL }))

    await act(() => app.graphSession.setGraph({ root: '/graphs/other', generation: GEN + 1 }))
    expect(result.current).toBeNull()
  })
})
