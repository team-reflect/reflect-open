import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowBootstrap } from '@reflect/core'

const windowBootstrap = vi.hoisted(() => vi.fn<() => Promise<WindowBootstrap>>())
const subscribeIndexWritten = vi.hoisted(() =>
  vi.fn<(handler: () => void) => Promise<() => void>>(),
)
const subscribeWindowNavigate = vi.hoisted(() =>
  vi.fn<(handler: (url: string) => void) => Promise<() => void>>(),
)
const isMainWindow = vi.hoisted(() => vi.fn(() => false))
const dispatchDeepLink = vi.hoisted(() => vi.fn())
const throttledInvalidateIndexQueries = vi.hoisted(() => vi.fn())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  windowBootstrap,
  subscribeIndexWritten,
  subscribeWindowNavigate,
}))
vi.mock('@/lib/windows/window-role', () => ({ isMainWindow }))
vi.mock('@/lib/deep-links/intake', () => ({ dispatchDeepLink }))
vi.mock('@/lib/query-client', () => ({ throttledInvalidateIndexQueries }))

import {
  getInitialWindowRoute,
  resetInitialWindowRouteForTests,
} from '@/lib/windows/initial-window-route'
import { useNoteWindowBoot } from './use-note-window-boot'

const BOOT: WindowBootstrap = {
  graph: { root: '/g', name: 'g', generation: 3 },
  indexGeneration: 5,
  initialDeepLink: 'reflect://note/notes%2Ffoo.md',
}

function mount() {
  const onAdopted = vi.fn()
  const onFailed = vi.fn()
  const view = renderHook(() =>
    useNoteWindowBoot({ platform: 'desktop', onAdopted, onFailed }),
  )
  return { onAdopted, onFailed, view }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetInitialWindowRouteForTests()
  isMainWindow.mockReturnValue(false)
  windowBootstrap.mockResolvedValue(BOOT)
  subscribeIndexWritten.mockResolvedValue(() => {})
  subscribeWindowNavigate.mockResolvedValue(() => {})
})

describe('useNoteWindowBoot', () => {
  it('adopts the open sessions and seeds the router from a path-shaped link', async () => {
    const { onAdopted, onFailed } = mount()
    await waitFor(() => expect(onAdopted).toHaveBeenCalledWith(BOOT))
    // ⌘-click links resolve synchronously — the route slot is seeded and the
    // intake is bypassed, so the window never flashes today's daily note.
    expect(getInitialWindowRoute()).toEqual({ kind: 'note', path: 'notes/foo.md' })
    expect(dispatchDeepLink).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()
    // The adopted window refetches on committed index writes — never its own
    // indexer — and honors focus-renavigate requests from a repeat ⌘-click
    // on its target. (Rename follow-through is desktop-root's, all windows.)
    expect(subscribeIndexWritten).toHaveBeenCalledWith(throttledInvalidateIndexQueries)
    expect(subscribeWindowNavigate).toHaveBeenCalledWith(dispatchDeepLink)
  })

  it('falls back to the intake for a target only the index can answer', async () => {
    windowBootstrap.mockResolvedValue({ ...BOOT, initialDeepLink: 'reflect://note/Meeting%20Notes' })
    const { onAdopted } = mount()
    await waitFor(() => expect(onAdopted).toHaveBeenCalled())
    expect(getInitialWindowRoute()).toBeNull()
    expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://note/Meeting%20Notes')
  })

  it('skips the deep-link dispatch when none is pending (a reload)', async () => {
    windowBootstrap.mockResolvedValue({ ...BOOT, initialDeepLink: null })
    const { onAdopted } = mount()
    await waitFor(() => expect(onAdopted).toHaveBeenCalled())
    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('parks the window on a failed bootstrap', async () => {
    windowBootstrap.mockRejectedValue(new Error('no graph is open'))
    const { onAdopted, onFailed } = mount()
    await waitFor(() => expect(onFailed).toHaveBeenCalled())
    expect(String(onFailed.mock.calls[0]![0])).toContain('no graph is open')
    expect(onAdopted).not.toHaveBeenCalled()
  })

  it('does nothing in the main window', async () => {
    isMainWindow.mockReturnValue(true)
    const { onAdopted, onFailed } = mount()
    await Promise.resolve()
    expect(windowBootstrap).not.toHaveBeenCalled()
    expect(onAdopted).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('unsubscribes both listeners on unmount', async () => {
    const unlistenWritten = vi.fn()
    const unlistenNavigate = vi.fn()
    subscribeIndexWritten.mockResolvedValue(unlistenWritten)
    subscribeWindowNavigate.mockResolvedValue(unlistenNavigate)
    const { onAdopted, view } = mount()
    await waitFor(() => expect(onAdopted).toHaveBeenCalled())
    view.unmount()
    expect(unlistenWritten).toHaveBeenCalled()
    expect(unlistenNavigate).toHaveBeenCalled()
  })
})
