import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { setBridge } from '@reflect/core'
import { GraphProvider, useGraph } from './graph-provider'
import { SettingsProvider } from './settings-provider'

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
/** The fake settings document (`mobileOnboarded` lives here). */
let settingsStore: Record<string, unknown>
/** A fresh QueryClient per test — the settings provider reads through it. */
let queryClient: QueryClient

/** The fixed mobile graph root the fake `mobile_graph_root` resolves to. */
const MOBILE_ROOT = '/Documents'

function installFakeBridge(): void {
  invokeLog = []
  pendingOpens = new Map()
  failOpens = false
  storedRecents = []
  storedFiles = []
  metaStore = {}
  settingsStore = {}
  let generation = 0
  setBridge({
    invoke: async (command, args) => {
      invokeLog.push(command === 'graph_open' ? `graph_open:${String(args['path'])}` : command)
      switch (command) {
        case 'graph_open': {
          if (failOpens) {
            throw { kind: 'io', message: 'cannot open graph' }
          }
          const root = String(args['path'])
          await new Promise<void>((resolve) => {
            pendingOpens.set(root, resolve)
          })
          generation += 1
          return { root, name: root.slice(1), cloudSync: null, generation }
        }
        case 'recent_graphs':
          return storedRecents
        case 'forget_recent':
          storedRecents = storedRecents.filter((recent) => recent.root !== String(args['root']))
          return null
        case 'mobile_graph_root':
          return MOBILE_ROOT
        case 'settings_load':
          return settingsStore
        case 'settings_save':
          settingsStore = args['settings'] as Record<string, unknown>
          return null
        case 'index_open':
          return generation
        case 'list_files':
          return storedFiles
        case 'index_meta_set':
          metaStore[String(args['key'])] = String(args['value'])
          return null
        case 'db_query': {
          // The only meta read the provider issues is the welcome marker.
          const sql = String(args['sql'] ?? '')
          if (/index_?meta/i.test(sql)) {
            const key = String((args['params'] as unknown[])?.[0])
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
  <QueryClientProvider client={queryClient}>
    <SettingsProvider>
      <GraphProvider>{children}</GraphProvider>
    </SettingsProvider>
  </QueryClientProvider>
)

const mobileWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <SettingsProvider>
      <GraphProvider platform="ios">{children}</GraphProvider>
    </SettingsProvider>
  </QueryClientProvider>
)

beforeEach(() => {
  installFakeBridge()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

    let firstOpen: Promise<boolean>
    let secondOpen: Promise<boolean>
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

  it('forgets the open graph and returns to the chooser', async () => {
    storedRecents = [{ root: '/known', name: 'known', openedMs: 1 }]
    const { result } = renderHook(() => useGraph(), { wrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has('/known')).toBe(true))
      resolveOpen('/known')
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    await act(async () => {
      await result.current.forget('/known')
    })

    expect(result.current.status).toBe('choosing')
    expect(result.current.graph).toBeNull()
    expect(result.current.indexGeneration).toBeNull()
    expect(result.current.recents).toEqual([])
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
    expect(metaStore['welcomeSeeded']).toBe('true')
  })

  it('never seeds a marked graph, even when it is empty (deleted notes stay deleted)', async () => {
    storedRecents = [{ root: '/known', name: 'known', openedMs: 1 }]
    metaStore['welcomeSeeded'] = 'true'
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
    expect(metaStore['welcomeSeeded']).toBe('true')
  })
})

describe('GraphProvider mobile onboarding (Plan 19, step 6)', () => {
  it('defers opening the fixed root and shows onboarding on a fresh install', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })

    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))
    expect(result.current.status).toBe('choosing')
    expect(result.current.graph).toBeNull()
    expect(result.current.mobileRoot).toBe(MOBILE_ROOT)
    // The root must stay untouched until the user chooses — the GitHub clone
    // path needs it empty (`git_clone` refuses a non-empty directory).
    expect(invokeLog).not.toContain(`graph_open:${MOBILE_ROOT}`)
  })

  it('opens the fixed root and records the flag on completeOnboarding', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))

    await act(async () => {
      const done = result.current.completeOnboarding()
      await waitFor(() => expect(pendingOpens.has(MOBILE_ROOT)).toBe(true))
      resolveOpen(MOBILE_ROOT)
      await done
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.needsOnboarding).toBe(false)
    expect(result.current.graph?.root).toBe(MOBILE_ROOT)
    // The gate is persisted (through the settings provider) so later launches
    // open the root directly — persistence trails the state update, so wait.
    await waitFor(() => expect(settingsStore['mobileOnboarded']).toBe(true))
  })

  it('keeps onboarding up (flag unset) when the open fails, for an in-app retry', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))

    failOpens = true
    await act(async () => {
      await expect(result.current.completeOnboarding()).rejects.toThrow()
    })

    // Open failed → onboarding stays up (the screen surfaces the thrown error)
    // for an in-app retry, and the flag is never persisted — no way to get
    // stranded past onboarding on a broken open.
    expect(result.current.needsOnboarding).toBe(true)
    expect(result.current.graph).toBeNull()
    expect(settingsStore['mobileOnboarded']).toBeUndefined()
  })

  it('opens the fixed root directly when already onboarded', async () => {
    settingsStore = { mobileOnboarded: true }
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has(MOBILE_ROOT)).toBe(true))
      resolveOpen(MOBILE_ROOT)
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.needsOnboarding).toBe(false)
    expect(result.current.graph?.root).toBe(MOBILE_ROOT)
  })
})
