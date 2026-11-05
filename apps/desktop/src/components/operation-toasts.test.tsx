import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOperationsService, type TestOperationsService } from '@reflect/app/testing'
import type { TestLoggerService } from '@reflect/core/testing'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import {
  clickToastAction,
  createTestToastController,
  withToasts,
  type TestToastController,
} from '@/test-utils/toast.tsx'
import { OperationToasts } from './operation-toasts.ts'

let operations: TestOperationsService
let logger: TestLoggerService
let toasts: TestToastController

beforeEach(async () => {
  operations = createTestOperationsService()
  toasts = createTestToastController()
  const { core } = await renderInApp(<OperationToasts />, {
    appServices: { operations },
    servicesOnly: true,
    wrapper: withToasts(toasts),
  })
  logger = core.logger
})

describe('OperationToasts', () => {
  it('creates and updates a toast with a stable operation id', async () => {
    const handle = await act(() => operations.start('Rebuilding search index'))

    expect(toasts.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'operation-1', title: 'Rebuilding search index' }),
    )

    await act(() => {
      handle.progress(3, 12)
    })

    expect(toasts.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'operation-1', description: '3/12' }),
    )
  })

  it('surfaces failures and closes the toast when the operation clears', async () => {
    const handle = await act(() => operations.start('Saving settings'))
    await act(() => {
      handle.fail('disk full')
    })

    expect(toasts.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'operation-1', description: 'disk full', type: 'error' }),
    )

    await act(() => operations.clock.advance(9_200))
    expect(toasts.close).toHaveBeenCalledWith('operation-1')
  })

  it('passes optional action metadata to the toast', async () => {
    const run = vi.fn()

    await act(() => {
      operations.start('Update available', { action: { label: 'Install', run }, persistent: true })
    })

    expect(toasts.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'operation-1',
        timeout: 0,
        data: { dismissible: false },
      }),
    )

    const options = toasts.add.mock.lastCall?.[0]
    expect(options?.actionProps?.children).toBe('Install')
    clickToastAction(options)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not remove the operation when a toast is dismissed', async () => {
    const handle = await act(() => operations.start('Saving settings'))

    expect(toasts.add.mock.lastCall?.[0]?.onClose).toBeUndefined()

    await act(() => {
      handle.fail('disk full')
    })

    expect(toasts.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'operation-1', description: 'disk full', type: 'error' }),
    )
  })

  it('consumes rejected action promises', async () => {
    const error = new Error('network down')
    const run = vi.fn(() => Promise.reject(error))
    await act(() => {
      operations.start('Update available', { action: { label: 'Install', run } })
    })

    const options = toasts.add.mock.lastCall?.[0]
    clickToastAction(options)
    await vi.waitFor(() => {
      expect(logger.getErrors()).toEqual([{ message: 'operation action failed:', cause: error }])
    })
  })
})
