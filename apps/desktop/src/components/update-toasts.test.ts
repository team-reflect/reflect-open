import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateController, UpdateState } from '@/lib/update-controller'
import type { MockToastAddOptions } from '@/test-utils/toast'
import { attachUpdateToasts } from './update-toasts'

const toast = vi.hoisted(() => ({
  add: vi.fn<(options: MockToastAddOptions) => string>(),
  close: vi.fn(),
}))

vi.mock('@/components/ui/toast', () => ({ toast }))

function createFakeController(): {
  controller: UpdateController
  setState: (next: UpdateState) => void
} {
  let state: UpdateState = { phase: 'idle' }
  const listeners = new Set<() => void>()
  const controller: UpdateController = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: vi.fn(),
    checkNow: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    dispose: vi.fn(),
  }
  return {
    controller,
    setState: (next) => {
      state = next
      for (const listener of listeners) {
        listener()
      }
    },
  }
}

afterEach(() => {
  toast.add.mockClear()
  toast.close.mockClear()
})

describe('attachUpdateToasts', () => {
  it('shows an install action when an update is available', () => {
    const { controller, setState } = createFakeController()
    attachUpdateToasts(controller)

    setState({ phase: 'available', version: '1.2.3' })

    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update available',
        description: 'Reflect 1.2.3 is ready to install.',
        timeout: 0,
        data: { dismissible: false },
        actionProps: expect.objectContaining({ children: 'Install' }),
      }),
    )

    const options = toast.add.mock.lastCall?.[0]
    options?.actionProps?.onClick()
    expect(controller.install).toHaveBeenCalledTimes(1)
  })

  it('updates the same toast while downloading and when ready', () => {
    const { controller, setState } = createFakeController()
    attachUpdateToasts(controller)
    expect(toast.close).toHaveBeenCalledWith('reflect-update')

    setState({ phase: 'available', version: '1.2.3' })
    setState({ phase: 'downloading', version: '1.2.3', percent: 42 })
    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Downloading update',
        description: '42%',
        type: 'loading',
      }),
    )

    // The downloading toast must explicitly clear the action: `add()` merges
    // options into the same-id toast, so without this the "Install" button
    // from the `available` phase would linger as a clickable control.
    const downloadingOptions = toast.add.mock.lastCall?.[0]
    expect(Object.hasOwn(downloadingOptions ?? {}, 'actionProps')).toBe(true)
    expect(downloadingOptions?.actionProps).toBeUndefined()

    setState({ phase: 'ready', version: '1.2.3' })
    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update ready',
        type: 'success',
        actionProps: expect.objectContaining({ children: 'Restart' }),
      }),
    )
  })

  it('surfaces install errors but ignores check-only failures', () => {
    const { controller, setState } = createFakeController()
    attachUpdateToasts(controller)

    setState({ phase: 'error', message: 'offline', during: 'check' })
    expect(toast.close).toHaveBeenCalledWith('reflect-update')
    expect(toast.add).not.toHaveBeenCalled()

    setState({ phase: 'error', message: 'signature failed', during: 'install' })
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update failed',
        description: 'signature failed',
        type: 'error',
        actionProps: expect.objectContaining({ children: 'Retry install' }),
      }),
    )
  })

  it('stops mirroring after detach', () => {
    const { controller, setState } = createFakeController()
    const detach = attachUpdateToasts(controller)
    detach()

    setState({ phase: 'available', version: '1.2.3' })
    expect(toast.add).not.toHaveBeenCalled()
  })
})
