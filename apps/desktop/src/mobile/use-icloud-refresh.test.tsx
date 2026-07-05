import { renderHook, act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { useICloudRefresh } from './use-icloud-refresh'

const graphState = vi.hoisted<{
  current: {
    graph: { root: string } | null
    mobileStorageKind: 'icloud' | 'local' | null
    refreshIndex: () => void
  }
}>(() => ({
  current: { graph: null, mobileStorageKind: null, refreshIndex: () => {} },
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => graphState.current,
}))

let downloadCalls: string[]
let countCalls: string[]
/** Full-scope (assets included) download requests — the deferred bulk. */
let allScopeDownloadCalls: string[]
/** What the fake pending commands report — note placeholders remaining. */
let pendingCount: number
let refreshIndex: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  vi.useFakeTimers()
  downloadCalls = []
  countCalls = []
  allScopeDownloadCalls = []
  pendingCount = 0
  refreshIndex = vi.fn<() => void>()
  graphState.current = {
    graph: { root: '/iCloud/Documents' },
    mobileStorageKind: 'icloud',
    refreshIndex,
  }
  setBridge({
    invoke: async (command, args) => {
      if (command === 'icloud_download_pending') {
        if (args['notesOnly'] === true) {
          downloadCalls.push(String(args['root']))
          return pendingCount
        }
        allScopeDownloadCalls.push(String(args['root']))
        return pendingCount
      }
      if (command === 'icloud_pending_count') {
        expect(args['notesOnly']).toBe(true) // the poll gates on the notes
        countCalls.push(String(args['root']))
        return pendingCount
      }
      return null
    },
    listen: async () => () => {},
  })
})

afterEach(() => {
  cleanup()
  setBridge(null)
  vi.useRealTimers()
  vi.clearAllMocks()
})

/** Let the pending `icloudDownloadPending` promise settle inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useICloudRefresh', () => {
  it('is inert for local graphs', async () => {
    graphState.current = {
      graph: { root: '/Documents' },
      mobileStorageKind: 'local',
      refreshIndex,
    }
    renderHook(() => useICloudRefresh())
    await flush()

    expect(downloadCalls).toEqual([])
    expect(refreshIndex).not.toHaveBeenCalled()
  })

  it('nudges note downloads on mount without repeating the open-time reconcile', async () => {
    renderHook(() => useICloudRefresh())
    await flush()

    expect(downloadCalls).toEqual(['/iCloud/Documents'])
    // The graph open just synced the index against local disk; an immediate
    // second full pass would repeat that work on a large first sync.
    expect(refreshIndex).not.toHaveBeenCalled()
    // No notes pending — the deferred bulk (assets) may start right away.
    expect(allScopeDownloadCalls).toEqual(['/iCloud/Documents'])
  })

  it('polls the note count while pending and reconciles + starts assets when they land', async () => {
    pendingCount = 3
    renderHook(() => useICloudRefresh())
    await flush()
    expect(downloadCalls).toHaveLength(1)
    expect(refreshIndex).not.toHaveBeenCalled()
    // Notes still pending — the bulk (assets) must wait its turn.
    expect(allScopeDownloadCalls).toHaveLength(0)

    // Still pending after one poll: no reconcile yet, keep waiting — and the
    // poll only counts, it never re-requests the downloads.
    await act(async () => {
      vi.runOnlyPendingTimers()
    })
    await flush()
    expect(countCalls).toHaveLength(1)
    expect(downloadCalls).toHaveLength(1)
    expect(refreshIndex).not.toHaveBeenCalled()

    // Notes finished: the next poll reconciles immediately — and only now
    // does the full-scope (assets) request fire.
    pendingCount = 0
    await act(async () => {
      vi.runOnlyPendingTimers()
    })
    await flush()
    expect(countCalls).toHaveLength(2)
    expect(refreshIndex).toHaveBeenCalledTimes(1)
    expect(allScopeDownloadCalls).toHaveLength(1)

    // Settled — no further polling.
    await act(async () => {
      vi.runOnlyPendingTimers()
    })
    await flush()
    expect(countCalls).toHaveLength(2)
  })

  it('gives up polling at the limit with one final reconcile', async () => {
    pendingCount = 3
    renderHook(() => useICloudRefresh())
    await flush()
    expect(refreshIndex).not.toHaveBeenCalled()

    // Never finishes downloading (a big asset on a slow link): the poll caps
    // out with a last reconcile instead of spinning forever.
    for (let i = 0; i < 25; i += 1) {
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      await flush()
    }
    expect(refreshIndex).toHaveBeenCalledTimes(1)
    // Well-bounded: one nudge, then at most limit/interval count polls.
    expect(downloadCalls).toHaveLength(1)
    expect(countCalls.length).toBeLessThanOrEqual(21)
    // Notes never drained, so the bulk request stays deferred — it would
    // compete with the notes still downloading on the slow link.
    expect(allScopeDownloadCalls).toHaveLength(0)
  })

  it('a failed nudge never starts the bulk download', async () => {
    // `pending` defaulting to 0 on error must not read as "notes are in".
    setBridge({
      invoke: async (command) => {
        if (command === 'icloud_download_pending') {
          throw { kind: 'io', message: 'container hiccup' }
        }
        return null
      },
      listen: async () => () => {},
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderHook(() => useICloudRefresh())
      await flush()

      expect(allScopeDownloadCalls).toHaveLength(0)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('collapses the resume event burst into one refresh — which reconciles', async () => {
    renderHook(() => useICloudRefresh())
    await flush()
    expect(downloadCalls).toHaveLength(1)

    // WKWebView fires visibilitychange + focus together on resume.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(downloadCalls).toHaveLength(1) // deduped — still within the window
    expect(refreshIndex).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(2000)
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(downloadCalls).toHaveLength(2) // a real later resume refreshes
    expect(refreshIndex).toHaveBeenCalledTimes(1) // and resume does reconcile
  })

  it('stops listening after unmount', async () => {
    const { unmount } = renderHook(() => useICloudRefresh())
    await flush()
    unmount()

    await act(async () => {
      vi.advanceTimersByTime(5000)
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(downloadCalls).toHaveLength(1)
  })
})
