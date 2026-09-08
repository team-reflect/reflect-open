import { renderHook } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { PinnedNote } from '@reflect/core'

const getPinnedNotes = vi.hoisted(() => vi.fn<() => Promise<PinnedNote[]>>(async () => []))
const readNote = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>())
const writeNote = vi.hoisted(() => vi.fn(async () => {}))
const openSession = vi.hoisted(() => vi.fn(() => null))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getPinnedNotes,
  readNote,
  writeNote,
}))
vi.mock('@/editor/open-documents', () => ({ openSession }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

const { resetNoteRowOverlays } = await import('./note-row-overlay')
const { toggleNotePinned } = await import('@/lib/note-pin')
const { usePinnedNotes } = await import('./use-pinned-notes')

const ROADMAP: PinnedNote = {
  path: 'notes/roadmap.md',
  title: 'Roadmap',
  dailyDate: null,
  pinnedOrder: null,
}

let client: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  resetNoteRowOverlays()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  getPinnedNotes.mockReset().mockResolvedValue([])
  readNote.mockReset().mockResolvedValue('# Roadmap\n')
  writeNote.mockReset().mockResolvedValue(undefined)
  openSession.mockReset().mockReturnValue(null)
})
afterEach(() => {
  resetNoteRowOverlays()
})

describe('usePinnedNotes', () => {
  it('shows a note pinned through the write before the index lists it', async () => {
    // The regression: ⌘O and the palette carry no optimism of their own, so
    // before the assertion moved into `toggleNotePinned` this shelf sat on the
    // stale index for a watcher round trip plus an invalidation window.
    const { result } = await renderHook(() => usePinnedNotes(), { wrapper })
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())
    expect(result.current).toEqual([])

    await toggleNotePinned('notes/roadmap.md', 7)

    await vi.waitFor(() =>
      expect(result.current.map((note) => note.path)).toEqual(['notes/roadmap.md']),
    )
  })

  it('hides a note unpinned through the write while the index still lists it', async () => {
    getPinnedNotes.mockResolvedValue([ROADMAP])
    readNote.mockResolvedValue('---\npinned: true\n---\n# Roadmap\n')
    const { result } = await renderHook(() => usePinnedNotes(), { wrapper })
    await vi.waitFor(() => expect(result.current).toHaveLength(1))

    await toggleNotePinned('notes/roadmap.md', 7)

    await vi.waitFor(() => expect(result.current).toEqual([]))
  })

  it('does not double-list the note once the index agrees', async () => {
    const { result } = await renderHook(() => usePinnedNotes(), { wrapper })
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())

    await toggleNotePinned('notes/roadmap.md', 7)
    await vi.waitFor(() => expect(result.current).toHaveLength(1))

    // The watcher catches up and the shelf query reports the note itself.
    getPinnedNotes.mockResolvedValue([ROADMAP])
    await client.invalidateQueries()

    await vi.waitFor(() => expect(result.current).toEqual([ROADMAP]))
  })
})
