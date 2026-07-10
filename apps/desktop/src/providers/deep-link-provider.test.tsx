import { StrictMode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'
import type { DeepLinkIo } from '@/lib/deep-links/handle'
import { beginLinkNavigationIntent } from '@/lib/windows/link-navigation-intent'

const setDeepLinkHandler = vi.hoisted(() => vi.fn<(handler: ((url: string) => void) | null) => void>())
const handleDeepLink = vi.hoisted(() =>
  vi.fn<(url: string, io: DeepLinkIo) => Promise<void>>(async () => {}),
)
const navigate = vi.hoisted(() => vi.fn())
const navigation = vi.hoisted(() => ({ revision: 0 }))

vi.mock('@/lib/deep-links/intake', () => ({ setDeepLinkHandler }))
vi.mock('@/lib/deep-links/handle', () => ({ handleDeepLink }))
vi.mock('@/routing/router', () => ({
  useRouter: () => ({ navigate, navigationRevision: () => navigation.revision }),
}))

import { DeepLinkProvider } from './deep-link-provider'

const GRAPH: GraphInfo = { root: '/g', name: 'g', generation: 7 }

function mount() {
  return render(<DeepLinkProvider graph={GRAPH}>{null}</DeepLinkProvider>)
}

/** The handler the provider attached on its most recent effect run. */
function attachedHandler(): (url: string) => void {
  const handler = setDeepLinkHandler.mock.calls.at(-1)?.[0]
  if (handler === null || handler === undefined) {
    throw new Error('no handler attached')
  }
  return handler
}

beforeEach(() => {
  vi.clearAllMocks()
  navigation.revision = 0
})

afterEach(cleanup)

describe('DeepLinkProvider', () => {
  it('attaches a handler on mount and detaches on unmount', () => {
    const view = mount()
    expect(setDeepLinkHandler).toHaveBeenLastCalledWith(expect.any(Function))

    view.unmount()
    expect(setDeepLinkHandler).toHaveBeenLastCalledWith(null)
  })

  it('routes URLs into handleDeepLink with the session io', () => {
    mount()

    attachedHandler()('reflect://today')

    expect(handleDeepLink).toHaveBeenCalledTimes(1)
    const [url, io] = handleDeepLink.mock.calls[0]!
    expect(url).toBe('reflect://today')
    expect(io.navigate).toBe(navigate)
    expect(io.generation).toBe(7)
  })

  it('reports stale when the graph session changes — an in-flight resolve must not navigate', () => {
    const view = mount()
    attachedHandler()('reflect://note/x')
    const io = handleDeepLink.mock.calls[0]![1]

    expect(io.isStale?.()).toBe(false)
    view.rerender(
      <DeepLinkProvider graph={{ ...GRAPH, generation: 8 }}>{null}</DeepLinkProvider>,
    )
    expect(io.isStale?.()).toBe(true)
  })

  it('reports stale when navigation changes while a note target resolves', () => {
    mount()
    attachedHandler()('reflect://note/x')
    const io = handleDeepLink.mock.calls[0]![1]

    expect(io.isStale?.()).toBe(false)
    navigation.revision += 1
    expect(io.isStale?.()).toBe(true)
  })

  it('reports stale when a newer note-link intent starts during resolution', () => {
    mount()
    attachedHandler()('reflect://note/x')
    const io = handleDeepLink.mock.calls[0]![1]

    expect(io.isStale?.()).toBe(false)
    beginLinkNavigationIntent()
    expect(io.isStale?.()).toBe(true)
  })

  it('a StrictMode probe cycle does not stale a link the probe attach drained', () => {
    // The note window's initial deep link buffers in the intake and is drained
    // by the FIRST attach — which in dev is StrictMode's probe run. Its async
    // note resolution must survive the probe's detach/reattach (same session),
    // or ⌘-clicked windows open on Today instead of the note.
    render(
      <StrictMode>
        <DeepLinkProvider graph={GRAPH}>{null}</DeepLinkProvider>
      </StrictMode>,
    )
    const probeHandler = setDeepLinkHandler.mock.calls[0]?.[0]
    expect(probeHandler).toEqual(expect.any(Function))
    probeHandler?.('reflect://note/x')

    const io = handleDeepLink.mock.calls[0]![1]
    expect(io.isStale?.()).toBe(false)
  })

  it('stays fresh after a plain unmount — the keyed remount makes the old router inert', () => {
    // Unmount alone is not a session change: on a graph switch the whole
    // keyed workspace remounts, so a late navigate hits a torn-down router
    // and no-ops. Staleness tracks the generation, nothing else.
    const view = mount()
    attachedHandler()('reflect://note/x')
    const io = handleDeepLink.mock.calls[0]![1]

    view.unmount()
    expect(io.isStale?.()).toBe(false)
  })

  it('logs a rejected handler instead of leaving an unhandled rejection', async () => {
    handleDeepLink.mockRejectedValueOnce(new Error('spool failed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    mount()
    attachedHandler()('reflect://append?text=x')

    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    errorSpy.mockRestore()
  })
})
