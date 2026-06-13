import { cleanup, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'

const controller = vi.hoisted(() => ({
  start: vi.fn(),
  schedule: vi.fn(),
  dispose: vi.fn(),
}))
const createCaptureController = vi.hoisted(() => vi.fn(() => controller))
const captureHostRegister = vi.hoisted(() => vi.fn<() => Promise<void>>())
const hasBridge = vi.hoisted(() => vi.fn(() => true))

vi.mock('@/lib/capture-controller', () => ({ createCaptureController }))
vi.mock('@reflect/core', () => ({ captureHostRegister, hasBridge }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { aiProviders: [], defaultAiProviderId: null },
  }),
}))

import { CaptureProvider } from './capture-provider'

const GRAPH: GraphInfo = { root: '/g', name: 'g', cloudSync: null, generation: 7 }

function mount(children: ReactNode = null) {
  return render(<CaptureProvider graph={GRAPH}>{children}</CaptureProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  hasBridge.mockReturnValue(true)
  captureHostRegister.mockResolvedValue(undefined)
})

afterEach(cleanup)

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

    mount()
    await waitFor(() => expect(captureHostRegister).toHaveBeenCalledTimes(1))
    expect(controller.start).not.toHaveBeenCalled()

    releaseRegistration()
    await waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
  })

  it('still starts the drain when registration fails — spooled captures must land', async () => {
    captureHostRegister.mockRejectedValue(new Error('manifest dir unwritable'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    mount()

    await waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('skips registration without a bridge (browser dev) but still mounts the controller', async () => {
    hasBridge.mockReturnValue(false)

    mount()

    await waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
    expect(captureHostRegister).not.toHaveBeenCalled()
  })

  it('disposes the controller on unmount', async () => {
    const view = mount()
    await waitFor(() => expect(controller.start).toHaveBeenCalled())
    view.unmount()
    expect(controller.dispose).toHaveBeenCalledTimes(1)
  })
})
