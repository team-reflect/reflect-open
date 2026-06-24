import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '@/lib/update-controller'
import { UpdateToast } from './update-toast'

const update = vi.hoisted(() => ({
  state: { phase: 'idle' } as UpdateState,
  install: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
}))

const toast = vi.hoisted(() => ({
  dismiss: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/providers/update-provider', () => ({
  useUpdate: () => ({
    state: update.state,
    supported: true,
    checkNow: vi.fn(async () => {}),
    install: update.install,
    restart: update.restart,
  }),
}))

vi.mock('sonner', () => ({ toast }))

afterEach(() => {
  cleanup()
  update.state = { phase: 'idle' }
  update.install.mockClear()
  update.restart.mockClear()
  toast.dismiss.mockClear()
  toast.error.mockClear()
  toast.loading.mockClear()
  toast.message.mockClear()
  toast.success.mockClear()
})

describe('UpdateToast', () => {
  it('shows an install action when an update is available', async () => {
    update.state = { phase: 'available', version: '1.2.3' }
    render(<UpdateToast />)

    await waitFor(() =>
      expect(toast.message).toHaveBeenCalledWith(
        'Update available',
        expect.objectContaining({
          id: 'reflect-update',
          closeButton: false,
          description: 'Reflect 1.2.3 is ready to install.',
          dismissible: false,
          action: expect.objectContaining({ label: 'Install' }),
        }),
      ),
    )

    const options = toast.message.mock.lastCall?.[1]
    options?.action?.onClick()
    expect(update.install).toHaveBeenCalledTimes(1)
  })

  it('updates the same toast while downloading and when ready', async () => {
    const { rerender } = render(<UpdateToast />)
    await waitFor(() => expect(toast.dismiss).toHaveBeenCalledWith('reflect-update'))

    update.state = { phase: 'downloading', version: '1.2.3', percent: 42 }
    rerender(<UpdateToast />)
    await waitFor(() =>
      expect(toast.loading).toHaveBeenCalledWith(
        'Downloading update',
        expect.objectContaining({ id: 'reflect-update', description: '42%' }),
      ),
    )

    // The downloading toast must explicitly clear the action: Sonner merges
    // options into the same-id toast, so without this the "Install" button
    // from the `available` phase would linger as a clickable control.
    const downloadingOptions = toast.loading.mock.lastCall?.[1]
    expect(Object.hasOwn(downloadingOptions ?? {}, 'action')).toBe(true)
    expect(downloadingOptions?.action).toBeUndefined()

    update.state = { phase: 'ready', version: '1.2.3' }
    rerender(<UpdateToast />)
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Update ready',
        expect.objectContaining({
          id: 'reflect-update',
          action: expect.objectContaining({ label: 'Restart' }),
        }),
      ),
    )
  })

  it('surfaces install errors but ignores check-only states', async () => {
    const { rerender } = render(<UpdateToast />)

    update.state = { phase: 'error', during: 'check', message: 'offline' }
    rerender(<UpdateToast />)
    await waitFor(() => expect(toast.dismiss).toHaveBeenCalledWith('reflect-update'))
    expect(toast.error).not.toHaveBeenCalled()

    update.state = { phase: 'error', during: 'install', message: 'signature failed' }
    rerender(<UpdateToast />)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Update failed',
        expect.objectContaining({
          id: 'reflect-update',
          description: 'signature failed',
          action: expect.objectContaining({ label: 'Retry install' }),
        }),
      ),
    )
  })
})
