import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import { resetOperations } from '@/lib/operations'
import { useNoteTrash } from './use-note-trash'

interface GraphValue {
  graph: { root: string; name: string; generation: number } | null
}
let graphValue: GraphValue
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => graphValue }))

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): ReactNode {
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  graphValue = { graph: { root: '/g', name: 'g', generation: 1 } }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(null)
})

afterEach(() => {
  setBridge(null) // don't leak the mock transport into other suites in this worker
  resetOperations() // drop the operations a failed run leaves lingering
})

describe('useNoteTrash', () => {
  it('reports a failure without trashing when no graph is open (never a silent success)', async () => {
    graphValue = { graph: null }
    const { result } = renderHook(() => useNoteTrash(), { wrapper })

    await expect(result.current.trash(['notes/a.md'])).resolves.toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('is a no-op for an empty selection', async () => {
    const { result } = renderHook(() => useNoteTrash(), { wrapper })

    await expect(result.current.trash([])).resolves.toBe(true)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('trashes every note and resolves true', async () => {
    const { result } = renderHook(() => useNoteTrash(), { wrapper })

    let trashed = false
    await act(async () => {
      trashed = await result.current.trash(['notes/a.md', 'notes/b.md'])
    })

    expect(trashed).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/a.md', generation: 1 })
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/b.md', generation: 1 })
  })

  it('keeps going past a per-note failure and resolves false', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'note_delete' && args['path'] === 'notes/b.md') {
        throw new Error('locked')
      }
      return null
    })
    const { result } = renderHook(() => useNoteTrash(), { wrapper })

    let trashed = true
    await act(async () => {
      trashed = await result.current.trash(['notes/a.md', 'notes/b.md', 'notes/c.md'])
    })

    // The batch reports failure but still attempted (and trashed) the others.
    expect(trashed).toBe(false)
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/a.md', generation: 1 })
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/c.md', generation: 1 })
  })
})
