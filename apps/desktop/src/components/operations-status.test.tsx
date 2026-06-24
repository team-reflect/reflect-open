import { act, cleanup, render, waitFor } from '@testing-library/react'
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
  cleanup()
  resetOperations()
})

describe('OperationsStatus', () => {
  it('creates and updates a Sonner toast with a stable operation id', async () => {
    render(<OperationsStatus />)

    let handle!: ReturnType<typeof startOperation>
    act(() => {
      handle = startOperation('Rebuilding search index')
    })

    await waitFor(() =>
      expect(toast.message).toHaveBeenLastCalledWith(
        'Rebuilding search index',
        expect.objectContaining({ id: 'operation-1' }),
      ),
    )

    act(() => handle.progress(3, 12))

    await waitFor(() =>
      expect(toast.message).toHaveBeenLastCalledWith(
        'Rebuilding search index',
        expect.objectContaining({ id: 'operation-1', description: '3/12' }),
      ),
    )
  })

  it('surfaces failures and dismisses the Sonner toast when the operation clears', async () => {
    vi.useFakeTimers()
    render(<OperationsStatus />)

    let handle!: ReturnType<typeof startOperation>
    act(() => {
      handle = startOperation('Saving settings')
    })
    act(() => handle.fail('disk full'))

    await act(async () => {})
    expect(toast.error).toHaveBeenLastCalledWith(
      'Saving settings',
      expect.objectContaining({ id: 'operation-1', description: 'disk full' }),
    )

    act(() => vi.advanceTimersByTime(9_200))

    expect(toast.dismiss).toHaveBeenCalledWith('operation-1')
    vi.useRealTimers()
  })

  it('passes optional action metadata to Sonner', async () => {
    render(<OperationsStatus />)
    const run = vi.fn()

    act(() => {
      startOperation('Update available', { action: { label: 'Install', run }, persistent: true })
    })

    await waitFor(() =>
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
    render(<OperationsStatus />)

    let handle!: ReturnType<typeof startOperation>
    act(() => {
      handle = startOperation('Saving settings')
    })

    await waitFor(() =>
      expect(toast.message).toHaveBeenLastCalledWith(
        'Saving settings',
        expect.not.objectContaining({ onDismiss: expect.any(Function) }),
      ),
    )

    act(() => handle.fail('disk full'))

    await waitFor(() =>
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
    render(<OperationsStatus />)

    act(() => {
      startOperation('Update available', { action: { label: 'Install', run } })
    })

    await waitFor(() => expect(toast.message).toHaveBeenCalled())
    const options = toast.message.mock.lastCall?.[1]
    options?.action?.onClick()
    await waitFor(() => expect(consoleError).toHaveBeenCalledWith('operation action failed:', error))

    consoleError.mockRestore()
  })
})
