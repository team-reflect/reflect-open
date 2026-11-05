import { beforeEach, describe, expect, it } from 'vitest'
import { createTestUpdateService } from '@reflect/app/testing'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import {
  clickToastAction,
  createTestToastController,
  withToasts,
  type TestToastController,
} from '@/test-utils/toast.tsx'
import { UpdateToasts } from './update-toasts.ts'

let toasts: TestToastController

beforeEach(() => {
  toasts = createTestToastController()
})

describe('UpdateToasts', () => {
  it('shows an install action when an update is available', async () => {
    const update = createTestUpdateService()
    await renderInApp(<UpdateToasts />, {
      appServices: { update },
      servicesOnly: true,
      wrapper: withToasts(toasts),
    })

    await act(() => update.setState({ phase: 'available', version: '1.2.3' }))

    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update available',
        description: 'Reflect 1.2.3 is ready to install.',
        timeout: 0,
        data: { dismissible: false },
      }),
    )

    const options = toasts.add.mock.lastCall?.[0]
    expect(options?.actionProps?.children).toBe('Install')
    clickToastAction(options)
    expect(update.calls).toEqual(['install'])
  })

  it('updates the same toast while downloading and when ready', async () => {
    const update = createTestUpdateService()
    await renderInApp(<UpdateToasts />, {
      appServices: { update },
      servicesOnly: true,
      wrapper: withToasts(toasts),
    })
    expect(toasts.close).toHaveBeenCalledWith('reflect-update')

    await act(() => update.setState({ phase: 'available', version: '1.2.3' }))
    await act(() => update.setState({ phase: 'downloading', version: '1.2.3', percent: 42 }))
    expect(toasts.add).toHaveBeenLastCalledWith(
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
    const downloadingOptions = toasts.add.mock.lastCall?.[0]
    expect(Object.hasOwn(downloadingOptions ?? {}, 'actionProps')).toBe(true)
    expect(downloadingOptions?.actionProps).toBeUndefined()

    await act(() => update.setState({ phase: 'ready', version: '1.2.3' }))
    expect(toasts.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update ready',
        type: 'success',
      }),
    )
    expect(toasts.add.mock.lastCall?.[0]?.actionProps?.children).toBe('Restart')
  })

  it('surfaces install errors but ignores check-only failures', async () => {
    const update = createTestUpdateService()
    await renderInApp(<UpdateToasts />, {
      appServices: { update },
      servicesOnly: true,
      wrapper: withToasts(toasts),
    })

    await act(() => update.setState({ phase: 'error', message: 'offline', during: 'check' }))
    expect(toasts.close).toHaveBeenCalledWith('reflect-update')
    expect(toasts.add).not.toHaveBeenCalled()

    await act(() => {
      update.setState({ phase: 'error', message: 'signature failed', during: 'install' })
    })
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update failed',
        description: 'signature failed',
        type: 'error',
      }),
    )

    const options = toasts.add.mock.lastCall?.[0]
    expect(options?.actionProps?.children).toBe('Retry install')
    clickToastAction(options)
    expect(update.calls).toEqual(['retryAction', 'install'])
  })

  it('stops mirroring after unmount', async () => {
    const update = createTestUpdateService()
    const { unmount } = await renderInApp(<UpdateToasts />, {
      appServices: { update },
      servicesOnly: true,
      wrapper: withToasts(toasts),
    })
    await unmount()

    await act(() => update.setState({ phase: 'available', version: '1.2.3' }))
    expect(toasts.add).not.toHaveBeenCalled()
  })
})
