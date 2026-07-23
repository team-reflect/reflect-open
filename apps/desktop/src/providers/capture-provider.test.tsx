import { render } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'

const controller = vi.hoisted(() => ({
  start: vi.fn(),
  schedule: vi.fn(),
  dispose: vi.fn(),
}))
const createCaptureController = vi.hoisted(() =>
  vi.fn((_options: { relaySharedInbox?: () => Promise<number> }) => controller),
)
const captureHostRegister = vi.hoisted(() => vi.fn<() => Promise<void>>())
const captureSharedInboxRelay = vi.hoisted(() => vi.fn<() => Promise<number>>())
const hasBridge = vi.hoisted(() => vi.fn(() => true))
const isMobileSurface = vi.hoisted(() => vi.fn(() => false))

vi.mock('@/lib/capture-controller', () => ({ createCaptureController }))
vi.mock('@reflect/core', () => ({ captureHostRegister, captureSharedInboxRelay, hasBridge }))
vi.mock('@/lib/platform-surface', () => ({ isMobileSurface }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { aiProviders: [], defaultAiProviderId: null },
  }),
}))

import { CaptureProvider } from './capture-provider'

const GRAPH: GraphInfo = { root: '/g', name: 'g', generation: 7 }

function mount(children: ReactNode = null) {
  return render(<CaptureProvider graph={GRAPH}>{children}</CaptureProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  hasBridge.mockReturnValue(true)
  isMobileSurface.mockReturnValue(false)
  captureHostRegister.mockResolvedValue(undefined)
  captureSharedInboxRelay.mockResolvedValue(0)
})

describe('CaptureProvider', () => {
  it('registers the host BEFORE the first drain pass', async () => {
    // Park registration: the controller must not start while the pointer
    // file may still name the previous graph.
    let releaseRegistration: () => void = () => {}
    captureHostRegister.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRegistration = resolve
        }),
    )

    await mount()
    await vi.waitFor(() => expect(captureHostRegister).toHaveBeenCalledTimes(1))
    expect(controller.start).not.toHaveBeenCalled()

    releaseRegistration()
    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
  })

  it('still starts the drain when registration fails — spooled captures must land', async () => {
    captureHostRegister.mockRejectedValue(new Error('manifest dir unwritable'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await mount()

    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('skips registration without a bridge (browser dev) but still mounts the controller', async () => {
    hasBridge.mockReturnValue(false)

    await mount()

    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
    expect(captureHostRegister).not.toHaveBeenCalled()
  })

  it('disposes the controller on unmount', async () => {
    const view = await mount()
    await vi.waitFor(() => expect(controller.start).toHaveBeenCalled())
    await view.unmount()
    expect(controller.dispose).toHaveBeenCalledTimes(1)
  })

  it('on mobile, skips host registration and wires the shared-inbox relay', async () => {
    isMobileSurface.mockReturnValue(true)

    await mount()

    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
    expect(captureHostRegister).not.toHaveBeenCalled()
    const options = createCaptureController.mock.calls[0]?.[0]
    expect(options?.relaySharedInbox).toBeDefined()
    await options?.relaySharedInbox?.()
    expect(captureSharedInboxRelay).toHaveBeenCalledWith(GRAPH.generation)
  })

  it('on desktop, passes no shared-inbox relay', async () => {
    await mount()
    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
    expect(createCaptureController.mock.calls[0]?.[0]?.relaySharedInbox).toBeUndefined()
  })
})
