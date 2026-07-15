import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteWindowNavigation, WindowBootstrap } from '@reflect/core'

const windowBootstrap = vi.hoisted(() => vi.fn<() => Promise<WindowBootstrap>>())
const subscribeIndexWritten = vi.hoisted(() =>
  vi.fn<(handler: () => void) => Promise<() => void>>(),
)
const subscribeWindowNavigate = vi.hoisted(() =>
  vi.fn<(handler: (navigation: NoteWindowNavigation) => void) => Promise<() => void>>(),
)
const isMainWindow = vi.hoisted(() => vi.fn(() => false))
const dispatchDeepLink = vi.hoisted(() => vi.fn())
const requestNoteHeadingReveal = vi.hoisted(() => vi.fn())
const throttledInvalidateIndexQueries = vi.hoisted(() => vi.fn())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  windowBootstrap,
  subscribeIndexWritten,
  subscribeWindowNavigate,
}))
vi.mock('@/lib/windows/window-role', () => ({ isMainWindow }))
vi.mock('@/lib/deep-links/intake', () => ({ dispatchDeepLink }))
vi.mock('@/editor/editor-handle-registry', () => ({ requestNoteHeadingReveal }))
vi.mock('@/lib/query-client', () => ({ throttledInvalidateIndexQueries }))

import {
  getInitialWindowRoute,
  resetInitialWindowRouteForTests,
} from '@/lib/windows/initial-window-route'
import { useNoteWindowBoot } from './use-note-window-boot'

const BOOT: WindowBootstrap = {
  graph: { root: '/g', name: 'g', generation: 3 },
  indexGeneration: 5,
  initialNavigation: {
    deepLink: 'reflect://note/notes%2Ffoo.md',
    headingReveal: null,
  },
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
    expect(subscribeWindowNavigate).toHaveBeenCalledWith(expect.any(Function))
  })

  it('queues the initial heading reveal before the secondary editor mounts', async () => {
    windowBootstrap.mockResolvedValue({
      ...BOOT,
      initialNavigation: {
        deepLink: 'reflect://note/Projects%2FPlan.md',
        headingReveal: { path: 'Projects/Plan.md', fragment: 'Roadmap' },
      },
    })

    const { onAdopted } = mount()

    await waitFor(() => expect(onAdopted).toHaveBeenCalled())
    expect(getInitialWindowRoute()).toEqual({ kind: 'note', path: 'Projects/Plan.md' })
    expect(requestNoteHeadingReveal).toHaveBeenCalledWith(
      'Projects/Plan.md',
      'Roadmap',
      3,
    )
    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('falls back to the intake for a target only the index can answer', async () => {
    windowBootstrap.mockResolvedValue({
      ...BOOT,
      initialNavigation: {
        deepLink: 'reflect://note/Meeting%20Notes',
        headingReveal: null,
      },
    })
    const { onAdopted } = mount()
    await waitFor(() => expect(onAdopted).toHaveBeenCalled())
    expect(getInitialWindowRoute()).toBeNull()
    expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://note/Meeting%20Notes')
  })

  it('skips the deep-link dispatch when none is pending (a reload)', async () => {
    windowBootstrap.mockResolvedValue({ ...BOOT, initialNavigation: null })
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

  it('reveals the heading carried by a focus-and-renavigate event', async () => {
    const { onAdopted } = mount()
    await waitFor(() => expect(onAdopted).toHaveBeenCalled())
    const handler = subscribeWindowNavigate.mock.calls[0]?.[0]
    if (handler === undefined) {
      throw new Error('expected the window navigation subscription')
    }

    handler({
      deepLink: 'reflect://note/Projects%2FPlan.md',
      headingReveal: { path: 'Projects/Plan.md', fragment: 'Decisions' },
    })

    expect(requestNoteHeadingReveal).toHaveBeenCalledWith(
      'Projects/Plan.md',
      'Decisions',
      3,
    )
    expect(dispatchDeepLink).toHaveBeenCalledWith(
      'reflect://note/Projects%2FPlan.md',
    )
  })
})
