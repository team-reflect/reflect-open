import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import { useNoteTrash } from './use-note-trash'

interface GraphValue {
  graph: { root: string; name: string; cloudSync: null; generation: number } | null
}
let graphValue: GraphValue
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => graphValue }))

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()
setBridge({ invoke: mockInvoke, listen: async () => () => {} })

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): ReactNode {
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  graphValue = { graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(null)
})

describe('useNoteTrash', () => {
  it('rejects without trashing when no graph is open (never a silent no-op success)', async () => {
    graphValue = { graph: null }
    const { result } = renderHook(() => useNoteTrash(), { wrapper })

    await expect(result.current.trash(['notes/a.md'])).rejects.toThrow(/no graph/i)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('is a no-op for an empty selection', async () => {
    const { result } = renderHook(() => useNoteTrash(), { wrapper })

    await expect(result.current.trash([])).resolves.toEqual([])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('trashes every note and resolves with no leftovers', async () => {
    const { result } = renderHook(() => useNoteTrash(), { wrapper })

    let failed: readonly string[] = ['unset']
    await act(async () => {
      failed = await result.current.trash(['notes/a.md', 'notes/b.md'])
    })

    expect(failed).toEqual([])
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/a.md', generation: 1 })
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/b.md', generation: 1 })
  })

  it('keeps going past a per-note failure and returns the leftovers', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'note_delete' && args.path === 'notes/b.md') {
        throw new Error('locked')
      }
      return null
    })
    const { result } = renderHook(() => useNoteTrash(), { wrapper })

    let failed: readonly string[] = []
    await act(async () => {
      failed = await result.current.trash(['notes/a.md', 'notes/b.md', 'notes/c.md'])
    })

    // Only the failure comes back; the others were still attempted and trashed.
    expect(failed).toEqual(['notes/b.md'])
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/a.md', generation: 1 })
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/c.md', generation: 1 })
  })
})
