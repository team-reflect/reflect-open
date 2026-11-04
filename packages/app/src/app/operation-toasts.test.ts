import { describe, expect, it, vi } from 'vitest'
import type { Operation } from '@reflect/core'
import { createTestLoggerService } from '@reflect/core/testing'
import { getOperationToast } from './operation-toasts.ts'

const OPERATION: Operation = {
  id: 1,
  label: 'Rebuilding search index',
  description: null,
  progress: null,
  status: 'running',
  persistent: false,
  action: null,
  message: null,
}

function getToast(operation: Partial<Operation>) {
  return getOperationToast({ ...OPERATION, ...operation }, createTestLoggerService())
}

describe('getOperationToast', () => {
  it('keys the toast by the operation id and shows the progress', () => {
    expect(getToast({ progress: { done: 3, total: 12 } })).toEqual(
      expect.objectContaining({
        id: 'operation-1',
        title: 'Rebuilding search index',
        description: '3/12',
        type: undefined,
        timeout: 0,
        dismissible: false,
      }),
    )
  })

  it('shows the message of a failure or a warning', () => {
    expect(getToast({ status: 'failed', message: 'disk full' })).toEqual(
      expect.objectContaining({ description: 'disk full', type: 'error' }),
    )
    expect(getToast({ status: 'warning', message: '2 skipped' })).toEqual(
      expect.objectContaining({ description: '2 skipped', type: 'warning' }),
    )
  })

  it('runs the operation action, and never closes the operation from the toast', () => {
    const run = vi.fn()
    const toast = getToast({ action: { label: 'Install', run } })

    expect(toast.action?.label).toBe('Install')
    toast.action?.run()
    expect(run).toHaveBeenCalledTimes(1)
    expect(toast.onClose).toBeUndefined()
  })

  it('logs a rejected action', async () => {
    const error = new Error('network down')
    const logger = createTestLoggerService()
    const toast = getOperationToast(
      { ...OPERATION, action: { label: 'Install', run: () => Promise.reject(error) } },
      logger,
    )

    toast.action?.run()
    await vi.waitFor(() => {
      expect(logger.getErrors()).toEqual([{ message: 'operation action failed:', cause: error }])
    })
  })
})
