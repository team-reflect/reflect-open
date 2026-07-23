import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetOperations, startOperation } from '@/lib/operations'
import { OperationsStatus } from './operations-status'

const toast = vi.hoisted(() => ({
  dismiss: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('sonner', () => ({ toast }))

beforeEach(() => {
  resetOperations()
  toast.dismiss.mockClear()
  toast.error.mockClear()
  toast.message.mockClear()
  toast.warning.mockClear()
})

afterEach(() => {
  resetOperations()
})

describe('OperationsStatus', () => {
  it('creates and updates a Sonner toast with a stable operation id', async () => {
    await render(<OperationsStatus />)

    const handle = startOperation('Rebuilding search index')

    await vi.waitFor(() =>
      expect(toast.message).toHaveBeenLastCalledWith(
        'Rebuilding search index',
        expect.objectContaining({ id: 'operation-1' }),
      ),
    )

    handle.progress(3, 12)

    await vi.waitFor(() =>
      expect(toast.message).toHaveBeenLastCalledWith(
        'Rebuilding search index',
        expect.objectContaining({ id: 'operation-1', description: '3/12' }),
      ),
    )
  })

  it('surfaces failures and dismisses the Sonner toast when the operation clears', async () => {
    vi.useFakeTimers()
    await render(<OperationsStatus />)

    const handle = startOperation('Saving settings')
    handle.fail('disk full')

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenLastCalledWith(
        'Saving settings',
        expect.objectContaining({ id: 'operation-1', description: 'disk full' }),
      ),
    )

    vi.advanceTimersByTime(9_200)
    vi.useRealTimers()

    await vi.waitFor(() => expect(toast.dismiss).toHaveBeenCalledWith('operation-1'))
  })

  it('passes optional action metadata to Sonner', async () => {
    await render(<OperationsStatus />)
    const run = vi.fn()

    startOperation('Update available', { action: { label: 'Install', run }, persistent: true })

    await vi.waitFor(() =>
      expect(toast.message).toHaveBeenLastCalledWith(
        'Update available',
        expect.objectContaining({
          id: 'operation-1',
          closeButton: false,
          action: expect.objectContaining({ label: 'Install' }),
          dismissible: false,
        }),
      ),
    )

    const options = toast.message.mock.lastCall?.[1]
    options?.action?.onClick()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not remove the operation when a toast is dismissed', async () => {
    await render(<OperationsStatus />)

    const handle = startOperation('Saving settings')

    await vi.waitFor(() =>
      expect(toast.message).toHaveBeenLastCalledWith(
        'Saving settings',
        expect.not.objectContaining({ onDismiss: expect.any(Function) }),
      ),
    )

    handle.fail('disk full')

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenLastCalledWith(
        'Saving settings',
        expect.objectContaining({ id: 'operation-1', description: 'disk full' }),
      ),
    )
  })

  it('consumes rejected action promises', async () => {
    const error = new Error('network down')
    const run = vi.fn(async () => {
      throw error
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(<OperationsStatus />)

    startOperation('Update available', { action: { label: 'Install', run } })

    await vi.waitFor(() => expect(toast.message).toHaveBeenCalled())
    const options = toast.message.mock.lastCall?.[1]
    options?.action?.onClick()
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('operation action failed:', error))

    consoleError.mockRestore()
  })
})
