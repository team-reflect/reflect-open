import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emitFileChanges,
  indexNote,
  readNote,
  resolveConflictMarkers,
  writeNoteIfUnchanged,
  type GraphInfo,
} from '@reflect/core'
import { invalidateIndexQueries } from '@/lib/query-client'
import { useConflictResolution } from './use-conflict-resolution'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote: vi.fn(),
  writeNoteIfUnchanged: vi.fn(async () => ({ kind: 'written', modifiedMs: null })),
  indexNote: vi.fn(async () => {}),
  emitFileChanges: vi.fn(),
}))
vi.mock('@/lib/query-client', () => ({ invalidateIndexQueries: vi.fn() }))

const graphState = vi.hoisted(() => ({
  graph: { root: '/g', name: 'G', generation: 3 } as GraphInfo | null,
  indexGeneration: 7 as number | null,
}))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => graphState }))

const SOURCE = [
  '<<<<<<< this device',
  'mine',
  '=======',
  'theirs',
  '>>>>>>> other device',
  '',
].join('\n')

beforeEach(() => {
  graphState.graph = { root: '/g', name: 'G', generation: 3 }
  graphState.indexGeneration = 7
  vi.mocked(readNote).mockResolvedValue(SOURCE)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useConflictResolution', () => {
  it('writes the spliced side, reindexes, and notifies open views', async () => {
    const { result } = renderHook(() => useConflictResolution('notes/clash.md'))

    await act(async () => {
      await result.current.resolve('ours')
    })

    const resolved = resolveConflictMarkers(SOURCE, 'ours')
    expect(vi.mocked(writeNoteIfUnchanged)).toHaveBeenCalledWith(
      'notes/clash.md',
      SOURCE,
      resolved,
      3,
    )
    expect(vi.mocked(indexNote)).toHaveBeenCalledWith('notes/clash.md', {
      generation: 7,
      content: resolved,
    })
    expect(vi.mocked(emitFileChanges)).toHaveBeenCalledWith([
      { path: 'notes/clash.md', kind: 'upsert' },
    ])
    expect(vi.mocked(invalidateIndexQueries)).toHaveBeenCalled()
    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  it('a failed write surfaces the error and notifies nothing', async () => {
    vi.mocked(writeNoteIfUnchanged).mockRejectedValueOnce({ kind: 'io', message: 'disk full' })
    const { result } = renderHook(() => useConflictResolution('notes/clash.md'))

    await act(async () => {
      await result.current.resolve('theirs')
    })

    expect(result.current.error).toBe('disk full')
    expect(vi.mocked(emitFileChanges)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidateIndexQueries)).not.toHaveBeenCalled()
  })

  it('refuses to overwrite a note changed or removed after the read', async () => {
    vi.mocked(writeNoteIfUnchanged).mockResolvedValueOnce({ kind: 'changed' })
    const { result } = renderHook(() => useConflictResolution('Projects/clash.md'))

    await act(async () => {
      await result.current.resolve('theirs')
    })

    expect(result.current.error).toBe(
      'This note changed or was removed before conflict resolution landed.',
    )
    expect(vi.mocked(indexNote)).not.toHaveBeenCalled()
    expect(vi.mocked(emitFileChanges)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidateIndexQueries)).not.toHaveBeenCalled()
  })

  it('a failed reindex still notifies — the file on disk did change', async () => {
    vi.mocked(indexNote).mockRejectedValueOnce({ kind: 'io', message: 'index closed' })
    const { result } = renderHook(() => useConflictResolution('notes/clash.md'))

    await act(async () => {
      await result.current.resolve('both')
    })

    expect(result.current.error).toBe('index closed')
    expect(vi.mocked(emitFileChanges)).toHaveBeenCalled()
    expect(vi.mocked(invalidateIndexQueries)).toHaveBeenCalled()
  })

  it('does nothing without an open graph', async () => {
    graphState.graph = null
    const { result } = renderHook(() => useConflictResolution('notes/clash.md'))

    await act(async () => {
      await result.current.resolve('ours')
    })

    expect(vi.mocked(readNote)).not.toHaveBeenCalled()
    expect(vi.mocked(writeNoteIfUnchanged)).not.toHaveBeenCalled()
  })
})
