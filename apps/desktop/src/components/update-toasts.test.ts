import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestUpdateService } from '@reflect/app/testing'
import { createTestLoggerService } from '@reflect/core/testing'
import type { MockToastAddOptions } from '@/test-utils/toast.ts'
import { attachUpdateToasts } from './update-toasts.ts'

const toast = vi.hoisted(() => ({
  add: vi.fn<(options: MockToastAddOptions) => string>(),
  close: vi.fn(),
}))

vi.mock('@/components/ui/toast.tsx', () => ({ toast }))

afterEach(() => {
  toast.add.mockClear()
  toast.close.mockClear()
})

describe('attachUpdateToasts', () => {
  it('shows an install action when an update is available', () => {
    const update = createTestUpdateService()
    attachUpdateToasts(update, createTestLoggerService())

    update.setState({ phase: 'available', version: '1.2.3' })

    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update available',
        description: 'Reflect 1.2.3 is ready to install.',
        timeout: 0,
        data: { dismissible: false },
      }),
    )

    const options = toast.add.mock.lastCall?.[0]
    expect(options?.actionProps?.children).toBe('Install')
    options?.actionProps?.onClick()
    expect(update.calls).toEqual(['install'])
  })

  it('updates the same toast while downloading and when ready', () => {
    const update = createTestUpdateService()
    attachUpdateToasts(update, createTestLoggerService())
    expect(toast.close).toHaveBeenCalledWith('reflect-update')

    update.setState({ phase: 'available', version: '1.2.3' })
    update.setState({ phase: 'downloading', version: '1.2.3', percent: 42 })
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

    update.setState({ phase: 'ready', version: '1.2.3' })
    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update ready',
        type: 'success',
      }),
    )
    expect(toast.add.mock.lastCall?.[0]?.actionProps?.children).toBe('Restart')
  })

  it('surfaces install errors but ignores check-only failures', () => {
    const update = createTestUpdateService()
    attachUpdateToasts(update, createTestLoggerService())

    update.setState({ phase: 'error', message: 'offline', during: 'check' })
    expect(toast.close).toHaveBeenCalledWith('reflect-update')
    expect(toast.add).not.toHaveBeenCalled()

    update.setState({ phase: 'error', message: 'signature failed', during: 'install' })
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update failed',
        description: 'signature failed',
        type: 'error',
      }),
    )

    const options = toast.add.mock.lastCall?.[0]
    expect(options?.actionProps?.children).toBe('Retry install')
    options?.actionProps?.onClick()
    expect(update.calls).toEqual(['retryAction', 'install'])
  })

  it('stops mirroring after detach', () => {
    const update = createTestUpdateService()
    const detach = attachUpdateToasts(update, createTestLoggerService())
    detach()

    update.setState({ phase: 'available', version: '1.2.3' })
    expect(toast.add).not.toHaveBeenCalled()
  })
})
