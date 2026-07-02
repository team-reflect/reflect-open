import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'
import type { DeepLinkIo } from '@/lib/deep-links/handle'

const setDeepLinkHandler = vi.hoisted(() => vi.fn<(handler: ((url: string) => void) | null) => void>())
const handleDeepLink = vi.hoisted(() =>
  vi.fn<(url: string, io: DeepLinkIo) => Promise<void>>(async () => {}),
)
const navigate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/deep-links/intake', () => ({ setDeepLinkHandler }))
vi.mock('@/lib/deep-links/handle', () => ({ handleDeepLink }))
vi.mock('@/routing/router', () => ({ useRouter: () => ({ navigate }) }))

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

  it('reports the session stale after unmount — an in-flight resolve must not navigate', () => {
    const view = mount()
    attachedHandler()('reflect://note/x')
    const io = handleDeepLink.mock.calls[0]![1]

    expect(io.isStale?.()).toBe(false)
    view.unmount()
    expect(io.isStale?.()).toBe(true)
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
