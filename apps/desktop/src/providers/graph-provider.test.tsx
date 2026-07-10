import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { setBridge } from '@reflect/core'
import { GraphProvider, useGraph } from './graph-provider'
import { SettingsProvider } from './settings-provider'
import { ICLOUD_STATUS_QUERY_KEY, queryClient as appQueryClient } from '@/lib/query-client'

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
/** The fake settings document (`mobileOnboarded`/`mobileStorage` live here). */
let settingsStore: Record<string, unknown>
/** What the fake `mobile_storage` resolves to — set before render. */
let storedStorage: {
  localRoot: string
  icloudDocumentsRoot: string | null
  icloudGraphRoots: string[]
}
/** When set, `mobile_storage` stays pending until {@link releaseStorage}. */
let storageHangs: boolean
let releaseStorage: () => void
/** A fresh QueryClient per test — the settings provider reads through it. */
let queryClient: QueryClient

/** The fixed mobile roots the fake `mobile_storage` reports. */
const MOBILE_ROOT = '/Documents'
const ICLOUD_ROOT = '/iCloud/Documents'
/** Where a fresh iCloud graph is created when the container is empty. */
const ICLOUD_GRAPH = `${ICLOUD_ROOT}/Notes`

function installFakeBridge(): void {
  invokeLog = []
  pendingOpens = new Map()
  failOpens = false
  storedRecents = []
  storedFiles = []
  metaStore = {}
  settingsStore = {}
  storedStorage = { localRoot: MOBILE_ROOT, icloudDocumentsRoot: ICLOUD_ROOT, icloudGraphRoots: [] }
  storageHangs = false
  releaseStorage = () => {}
  let generation = 0
  setBridge({
    invoke: async (command, args) => {
      invokeLog.push(
        command === 'graph_open' || command === 'graph_create'
          ? `${command}:${String(args['path'])}`
          : command,
      )
      switch (command) {
        case 'graph_create': {
          const root = String(args['path'])
          generation += 1
          return { root, name: root.split('/').filter(Boolean).at(-1) ?? '', generation }
        }
        case 'graph_open': {
          if (failOpens) {
            throw { kind: 'io', message: 'cannot open graph' }
          }
          const root = String(args['path'])
          await new Promise<void>((resolve) => {
            pendingOpens.set(root, resolve)
          })
          generation += 1
          return { root, name: root.split('/').filter(Boolean).at(-1) ?? '', generation }
        }
        case 'recent_graphs':
          return storedRecents
        case 'forget_recent':
          storedRecents = storedRecents.filter((recent) => recent.root !== String(args['root']))
          return null
        case 'mobile_storage':
          if (storageHangs) {
            await new Promise<void>((resolve) => {
              releaseStorage = resolve
            })
          }
          return storedStorage
        case 'mobile_storage_local':
          return storedStorage.localRoot
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

  it('closes note windows BEFORE the backend open bumps the session', async () => {
    // Note windows adopted the outgoing session; their close-requested
    // flushes must land against its still-valid generation, so the close
    // command precedes graph_open (bump-first would reject the saves).
    const { result } = renderHook(() => useGraph(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('choosing'))

    let opened: Promise<boolean>
    act(() => {
      opened = result.current.openRecent('/a')
    })
    await waitFor(() => expect(invokeLog).toContain('graph_open:/a'))
    expect(invokeLog.indexOf('close_note_windows')).toBeGreaterThanOrEqual(0)
    expect(invokeLog.indexOf('close_note_windows')).toBeLessThan(
      invokeLog.indexOf('graph_open:/a'),
    )
    await act(async () => {
      resolveOpen('/a')
      await opened
    })
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

  it('drops the cached iCloud listing when the graph is deleted', async () => {
    storedRecents = [{ root: '/known', name: 'known', openedMs: 1 }]
    const { result } = renderHook(() => useGraph(), { wrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has('/known')).toBe(true))
      resolveOpen('/known')
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    // The chooser's listing was cached before the delete; without the drop it
    // would keep showing the deleted graph (queries never go stale on their own).
    appQueryClient.setQueryData(ICLOUD_STATUS_QUERY_KEY, {
      available: true,
      documentsRoot: '/icloud/Documents',
      existingGraphRoots: ['/known'],
    })

    await act(async () => {
      await result.current.deleteGraph()
    })

    expect(invokeLog).toContain('graph_delete')
    expect(result.current.status).toBe('choosing')
    expect(appQueryClient.getQueryData(ICLOUD_STATUS_QUERY_KEY)).toBeUndefined()
  })

  it('returns to the graph chooser without opening the folder picker', async () => {
    storedRecents = [{ root: '/known', name: 'known', openedMs: 1 }]
    const { result } = renderHook(() => useGraph(), { wrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has('/known')).toBe(true))
      resolveOpen('/known')
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    vi.mocked(open).mockClear()
    await act(async () => {
      await result.current.chooseGraph()
    })

    expect(result.current.status).toBe('choosing')
    expect(result.current.graph).toBeNull()
    expect(result.current.indexGeneration).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(result.current.recents).toEqual(storedRecents)
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

describe('GraphProvider mobile onboarding (Plans 19/21)', () => {
  it('defers opening the fixed roots and shows onboarding on a fresh install', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })

    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))
    expect(result.current.status).toBe('choosing')
    expect(result.current.graph).toBeNull()
    expect(result.current.mobileStorageInfo).toEqual({
      localRoot: MOBILE_ROOT,
      icloudDocumentsRoot: ICLOUD_ROOT,
      icloudGraphRoots: [],
    })
    // The roots must stay untouched until the user chooses — the GitHub clone
    // path needs the local one empty (`git_clone` refuses a non-empty
    // directory), and opening the iCloud one would bootstrap + seed it.
    expect(invokeLog).not.toContain(`graph_open:${MOBILE_ROOT}`)
    expect(invokeLog).not.toContain(`graph_open:${ICLOUD_GRAPH}`)
    expect(invokeLog).not.toContain(`graph_create:${ICLOUD_GRAPH}`)
  })

  it('opens the local root and records flag + kind on completeOnboarding(local)', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))

    await act(async () => {
      const done = result.current.completeOnboarding('local')
      await waitFor(() => expect(pendingOpens.has(MOBILE_ROOT)).toBe(true))
      resolveOpen(MOBILE_ROOT)
      await done
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.needsOnboarding).toBe(false)
    expect(result.current.graph?.root).toBe(MOBILE_ROOT)
    expect(result.current.mobileStorageKind).toBe('local')
    // The gate is persisted (through the settings provider) so later launches
    // open the root directly — persistence trails the state update, so wait.
    await waitFor(() => expect(settingsStore['mobileOnboarded']).toBe(true))
    expect(settingsStore['mobileStorage']).toBe('local')
  })

  it('defers the first mobile index pass while hidden and replays it on foreground', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
      await waitFor(() => expect(result.current.needsOnboarding).toBe(true))

      await act(async () => {
        const done = result.current.completeOnboarding('local')
        await waitFor(() => expect(pendingOpens.has(MOBILE_ROOT)).toBe(true))
        resolveOpen(MOBILE_ROOT)
        await done
      })
      await waitFor(() => expect(metaStore['welcomeSeeded']).toBe('true'))
      await act(async () => {
        await Promise.resolve()
      })

      expect(invokeLog).not.toContain('index_clear')
      expect(invokeLog).not.toContain('index_reconcile_scan')

      visibility.mockReturnValue('visible')
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })

      // Resume performs a full sync, which catches files and local events the
      // intentionally absent live subscription could not observe while hidden.
      await waitFor(() => expect(invokeLog).toContain('index_clear'))
    } finally {
      visibility.mockRestore()
    }
  })

  it('clears suspension when mobile foregrounds before its index session opens', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
      await waitFor(() => expect(result.current.needsOnboarding).toBe(true))
      expect(result.current.indexGeneration).toBeNull()

      // The app foregrounds while onboarding still has no graph/index. This
      // must clear the sticky suspension even though there is nothing to sync.
      visibility.mockReturnValue('visible')
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })

      await act(async () => {
        const done = result.current.completeOnboarding('local')
        await waitFor(() => expect(pendingOpens.has(MOBILE_ROOT)).toBe(true))
        resolveOpen(MOBILE_ROOT)
        await done
      })

      await waitFor(() => expect(invokeLog).toContain('index_clear'))
      expect(result.current.status).toBe('ready')
    } finally {
      visibility.mockRestore()
    }
  })

  it('creates the default container graph and records kind + name on completeOnboarding(icloud)', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))

    await act(async () => {
      const done = result.current.completeOnboarding('icloud')
      await waitFor(() => expect(pendingOpens.has(ICLOUD_GRAPH)).toBe(true))
      resolveOpen(ICLOUD_GRAPH)
      await done
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.graph?.root).toBe(ICLOUD_GRAPH)
    expect(result.current.mobileStorageKind).toBe('icloud')
    expect(invokeLog).toContain(`graph_create:${ICLOUD_GRAPH}`)
    await waitFor(() => expect(settingsStore['mobileOnboarded']).toBe(true))
    expect(settingsStore['mobileStorage']).toBe('icloud')
    // WHICH graph is remembered by name — never by container path.
    expect(settingsStore['mobileGraphName']).toBe('Notes')
  })

  it('opens the explicitly chosen container graph and persists its name', async () => {
    storedStorage = {
      localRoot: MOBILE_ROOT,
      icloudDocumentsRoot: ICLOUD_ROOT,
      icloudGraphRoots: [`${ICLOUD_ROOT}/Notes`, `${ICLOUD_ROOT}/Work`],
    }
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))

    await act(async () => {
      const done = result.current.completeOnboarding('icloud', `${ICLOUD_ROOT}/Work`)
      await waitFor(() => expect(pendingOpens.has(`${ICLOUD_ROOT}/Work`)).toBe(true))
      resolveOpen(`${ICLOUD_ROOT}/Work`)
      await done
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.graph?.root).toBe(`${ICLOUD_ROOT}/Work`)
    expect(invokeLog).not.toContain(`graph_create:${ICLOUD_ROOT}/Work`)
    await waitFor(() => expect(settingsStore['mobileGraphName']).toBe('Work'))
  })

  it('creates an explicitly named iCloud graph when it is not already known', async () => {
    const journalRoot = `${ICLOUD_ROOT}/Journal`
    storedStorage = {
      localRoot: MOBILE_ROOT,
      icloudDocumentsRoot: ICLOUD_ROOT,
      icloudGraphRoots: [`${ICLOUD_ROOT}/Notes`],
    }
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))

    await act(async () => {
      const done = result.current.completeOnboarding('icloud', journalRoot)
      await waitFor(() => expect(pendingOpens.has(journalRoot)).toBe(true))
      resolveOpen(journalRoot)
      await done
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(invokeLog).toContain(`graph_create:${journalRoot}`)
    await waitFor(() => expect(settingsStore['mobileGraphName']).toBe('Journal'))
  })

  it('shows onboarding immediately while the iCloud container is still resolving', async () => {
    storageHangs = true
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })

    // Onboarding must not wait on the container lookup — on a fresh install
    // that call can take a long time, and it used to hold the whole app on a
    // bare "Loading…" screen.
    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))
    expect(result.current.mobileStorageResolving).toBe(true)
    // The sandbox root seeds instantly so the on-device/GitHub paths work.
    await waitFor(() => expect(result.current.mobileStorageInfo?.localRoot).toBe(MOBILE_ROOT))
    expect(result.current.mobileStorageInfo?.icloudDocumentsRoot).toBeNull()

    await act(async () => {
      releaseStorage()
    })
    await waitFor(() => expect(result.current.mobileStorageResolving).toBe(false))
    expect(result.current.mobileStorageInfo?.icloudDocumentsRoot).toBe(ICLOUD_ROOT)
  })

  it('rejects completeOnboarding(icloud) when iCloud is unavailable', async () => {
    storedStorage = { localRoot: MOBILE_ROOT, icloudDocumentsRoot: null, icloudGraphRoots: [] }
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))

    await act(async () => {
      await expect(result.current.completeOnboarding('icloud')).rejects.toThrow(
        /iCloud Drive isn’t available/,
      )
    })
    expect(result.current.needsOnboarding).toBe(true)
    expect(settingsStore['mobileOnboarded']).toBeUndefined()
  })

  it('keeps onboarding up (flag unset) when the open fails, for an in-app retry', async () => {
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })
    await waitFor(() => expect(result.current.needsOnboarding).toBe(true))

    failOpens = true
    await act(async () => {
      await expect(result.current.completeOnboarding('local')).rejects.toThrow()
    })

    // Open failed → onboarding stays up (the screen surfaces the thrown error)
    // for an in-app retry, and the flag is never persisted — no way to get
    // stranded past onboarding on a broken open.
    expect(result.current.needsOnboarding).toBe(true)
    expect(result.current.graph).toBeNull()
    expect(settingsStore['mobileOnboarded']).toBeUndefined()
  })

  it('opens the local root directly when onboarded without a storage kind (pre-Plan-21 installs)', async () => {
    settingsStore = { mobileOnboarded: true }
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has(MOBILE_ROOT)).toBe(true))
      resolveOpen(MOBILE_ROOT)
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.needsOnboarding).toBe(false)
    expect(result.current.graph?.root).toBe(MOBILE_ROOT)
    expect(result.current.mobileStorageKind).toBe('local')
  })

  it('opens the first container graph when onboarded onto iCloud with no saved name (pre-multi-graph installs)', async () => {
    settingsStore = { mobileOnboarded: true, mobileStorage: 'icloud' }
    storedStorage = {
      localRoot: MOBILE_ROOT,
      icloudDocumentsRoot: ICLOUD_ROOT,
      icloudGraphRoots: [ICLOUD_GRAPH],
    }
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has(ICLOUD_GRAPH)).toBe(true))
      resolveOpen(ICLOUD_GRAPH)
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.graph?.root).toBe(ICLOUD_GRAPH)
    expect(result.current.mobileStorageKind).toBe('icloud')
  })

  it('opens the graph named in settings when the container holds several', async () => {
    settingsStore = { mobileOnboarded: true, mobileStorage: 'icloud', mobileGraphName: 'Work' }
    storedStorage = {
      localRoot: MOBILE_ROOT,
      icloudDocumentsRoot: ICLOUD_ROOT,
      icloudGraphRoots: [`${ICLOUD_ROOT}/Notes`, `${ICLOUD_ROOT}/Work`],
    }
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })

    await act(async () => {
      await waitFor(() => expect(pendingOpens.has(`${ICLOUD_ROOT}/Work`)).toBe(true))
      resolveOpen(`${ICLOUD_ROOT}/Work`)
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.graph?.root).toBe(`${ICLOUD_ROOT}/Work`)
  })

  it('parks on an honest error when the iCloud graph is unreachable (signed out)', async () => {
    settingsStore = { mobileOnboarded: true, mobileStorage: 'icloud' }
    storedStorage = { localRoot: MOBILE_ROOT, icloudDocumentsRoot: null, icloudGraphRoots: [] }
    const { result } = renderHook(() => useGraph(), { wrapper: mobileWrapper })

    await waitFor(() => expect(result.current.status).toBe('choosing'))
    // No silent fallback to the empty local root — that would look like the
    // user's notes vanished. The error names the fix instead.
    expect(result.current.needsOnboarding).toBe(false)
    expect(result.current.error).toMatch(/iCloud isn’t available/)
    expect(invokeLog).not.toContain(`graph_open:${MOBILE_ROOT}`)
  })
})
