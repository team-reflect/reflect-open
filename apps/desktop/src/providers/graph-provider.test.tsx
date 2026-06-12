import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { setBridge } from '@reflect/core'
import { GraphProvider, useGraph } from './graph-provider'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

/**
 * Exercises the provider's open-ordering guards: overlapping opens are
 * serialized against the backend and only the most recently requested one may
 * commit UI state.
 */

let invokeLog: string[]
/** Pending `graph_open` resolvers keyed by requested root. */
let pendingOpens: Map<string, () => void>
let failOpens: boolean
/** What `recent_graphs` returns — set before render to simulate prior opens. */
let storedRecents: Array<{ root: string; name: string; openedMs: number }>

function installFakeBridge(): void {
  invokeLog = []
  pendingOpens = new Map()
  failOpens = false
  storedRecents = []
  let generation = 0
  setBridge({
    invoke: async (command, args) => {
      invokeLog.push(command === 'graph_open' ? `graph_open:${String(args.path)}` : command)
      switch (command) {
        case 'graph_open': {
          if (failOpens) {
            throw { kind: 'io', message: 'cannot open graph' }
          }
          const root = String(args.path)
          await new Promise<void>((resolve) => {
            pendingOpens.set(root, resolve)
          })
          generation += 1
          return { root, name: root.slice(1), cloudSync: null, generation }
        }
        case 'recent_graphs':
          return storedRecents
        case 'index_open':
          return generation
        case 'list_files':
        case 'db_query':
          return []
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

function resolveOpen(root: string): void {
  pendingOpens.get(root)?.()
  pendingOpens.delete(root)
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <GraphProvider>{children}</GraphProvider>
)

beforeEach(() => {
  installFakeBridge()
})

afterEach(() => {
  setBridge(null)
})

describe('GraphProvider open sequencing', () => {
  it('starts at the chooser when there are no recents', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('choosing'))
    expect(result.current.graph).toBeNull()
  })

  it('serializes overlapping opens and commits only the last requested graph', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('choosing'))

    let firstOpen: Promise<void>
    let secondOpen: Promise<void>
    act(() => {
      firstOpen = result.current.openRecent('/a')
      secondOpen = result.current.openRecent('/b')
    })

    // The second backend open must wait for the first (Rust GraphState is
    // last-write-wins; running in request order keeps it on the last graph).
    await waitFor(() => expect(invokeLog).toContain('graph_open:/a'))
    expect(invokeLog).not.toContain('graph_open:/b')

    await act(async () => {
      resolveOpen('/a')
      await waitFor(() => expect(invokeLog).toContain('graph_open:/b'))
      resolveOpen('/b')
      await firstOpen
      await secondOpen
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    // The superseded first open must not have committed its graph.
    expect(result.current.graph?.root).toBe('/b')
  })

  it('surfaces an open failure and returns to the chooser', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('choosing'))

    failOpens = true
    await act(async () => {
      await result.current.openRecent('/broken')
    })

    expect(result.current.status).toBe('choosing')
    expect(result.current.error).toMatch(/cannot open graph/)
  })
})

describe('GraphProvider welcome seeding', () => {
  it('seeds the welcome note when the user picks a brand-new empty folder', async () => {
    vi.mocked(open).mockResolvedValue('/fresh')
    const { result } = renderHook(() => useGraph(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('choosing'))

    await act(async () => {
      const picking = result.current.pickAndOpen()
      await waitFor(() => expect(pendingOpens.has('/fresh')).toBe(true))
      resolveOpen('/fresh')
      await picking
    })

    expect(result.current.status).toBe('ready')
    expect(invokeLog).toContain('note_write')
  })

  it('never seeds a previously-opened graph, even when it is empty', async () => {
    // '/known' is in recents: it auto-opens on mount, and re-picking it via
    // the folder picker is also not a first open.
    storedRecents = [{ root: '/known', name: 'known', openedMs: 1 }]
    vi.mocked(open).mockResolvedValue('/known')
    const { result } = renderHook(() => useGraph(), { wrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has('/known')).toBe(true))
      resolveOpen('/known')
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    await act(async () => {
      const picking = result.current.pickAndOpen()
      await waitFor(() => expect(pendingOpens.has('/known')).toBe(true))
      resolveOpen('/known')
      await picking
    })

    expect(invokeLog).not.toContain('note_write')
  })
})
