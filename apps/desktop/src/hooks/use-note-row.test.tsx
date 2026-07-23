import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import type { NoteRow } from '@reflect/core'
import { getNoteRowOverlay, resetNoteRowOverlays, setNoteRowOverlay } from './note-row-overlay'
import { useNoteRow } from './use-note-row'

const GENERATION = 5

const getNote = vi.hoisted(() => vi.fn<(path: string) => Promise<NoteRow | undefined>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getNote,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: GENERATION } }),
}))

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md',
    title: 'A',
    dailyDate: null,
    isPrivate: false,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  getNote.mockReset()
  resetNoteRowOverlays()
})
afterEach(() => {
  resetNoteRowOverlays()
})

describe('useNoteRow', () => {
  it('returns the index row', async () => {
    getNote.mockResolvedValue(noteRow({ gistUrl: 'from-index' }))
    const { result } = await renderHook(() => useNoteRow('notes/a.md'), { wrapper: makeWrapper() })
    await vi.waitFor(() => expect(result.current?.gistUrl).toBe('from-index'))
  })

  it('overlays a freshly-written value over a lagging index row', async () => {
    getNote.mockResolvedValue(noteRow({ gistUrl: null })) // index hasn't seen the publish yet
    const { result, act } = await renderHook(() => useNoteRow('notes/a.md'), {
      wrapper: makeWrapper(),
    })
    await vi.waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current?.gistUrl).toBeNull()

    await act(() => setNoteRowOverlay('notes/a.md', GENERATION, { gistUrl: 'pending' }))
    await vi.waitFor(() => expect(result.current?.gistUrl).toBe('pending'))
  })

  it('retires the overlay once the index row catches up to it', async () => {
    setNoteRowOverlay('notes/a.md', GENERATION, { gistUrl: 'u' })
    getNote.mockResolvedValue(noteRow({ gistUrl: 'u' })) // index already agrees
    const { result } = await renderHook(() => useNoteRow('notes/a.md'), { wrapper: makeWrapper() })

    await vi.waitFor(() => expect(result.current?.gistUrl).toBe('u'))
    await vi.waitFor(() => expect(getNoteRowOverlay('notes/a.md', GENERATION)).toBeNull())
  })
})
