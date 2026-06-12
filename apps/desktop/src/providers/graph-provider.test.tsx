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
/** What `list_files` returns — set before render to simulate existing notes. */
let storedFiles: Array<{ path: string; size: number; modifiedMs: number }>
/** The fake `index_meta` table (the welcome marker lives here). */
let metaStore: Record<string, string>

function installFakeBridge(): void {
  invokeLog = []
  pendingOpens = new Map()
  failOpens = false
  storedRecents = []
  storedFiles = []
  metaStore = {}
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
          return storedFiles
        case 'index_meta_set':
          metaStore[String(args.key)] = String(args.value)
          return null
        case 'db_query': {
          // The only meta read the provider issues is the welcome marker.
          const sql = String(args.sql ?? '')
          if (/index_?meta/i.test(sql)) {
            const key = String((args.params as unknown[])?.[0])
            return key in metaStore ? [{ value: metaStore[key] }] : []
          }
          return []
        }
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
  it('seeds an empty unmarked graph and stamps the welcomeSeeded marker', async () => {
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
    expect(metaStore.welcomeSeeded).toBe('true')
  })

  it('never seeds a marked graph, even when it is empty (deleted notes stay deleted)', async () => {
    storedRecents = [{ root: '/known', name: 'known', openedMs: 1 }]
    metaStore.welcomeSeeded = 'true'
    const { result } = renderHook(() => useGraph(), { wrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has('/known')).toBe(true))
      resolveOpen('/known')
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(invokeLog).not.toContain('note_write')
  })

  it('marks an unmarked graph with existing notes without writing into it', async () => {
    storedRecents = [{ root: '/existing', name: 'existing', openedMs: 1 }]
    storedFiles = [{ path: 'daily/2026-06-12.md', size: 10, modifiedMs: 0 }]
    const { result } = renderHook(() => useGraph(), { wrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has('/existing')).toBe(true))
      resolveOpen('/existing')
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(invokeLog).not.toContain('note_write')
    // Onboarding was considered: emptying this graph later won't re-seed.
    expect(metaStore.welcomeSeeded).toBe('true')
  })
})
