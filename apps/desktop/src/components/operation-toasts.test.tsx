import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOperationsService, type TestOperationsService } from '@reflect/app/testing'
import type { TestLoggerService } from '@reflect/core/testing'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import type { MockToastAddOptions } from '@/test-utils/toast.ts'
import { OperationToasts } from './operation-toasts.ts'

const toast = vi.hoisted(() => ({
  add: vi.fn<(options: MockToastAddOptions) => string>(),
  close: vi.fn(),
}))

vi.mock('@/components/ui/toast.tsx', () => ({ toast }))

let operations: TestOperationsService
let logger: TestLoggerService

beforeEach(async () => {
  operations = createTestOperationsService()
  toast.add.mockClear()
  toast.close.mockClear()
  const { core } = await renderInApp(<OperationToasts />, {
    appServices: { operations },
    servicesOnly: true,
  })
  logger = core.logger
})

describe('OperationToasts', () => {
  it('creates and updates a toast with a stable operation id', async () => {
    const handle = await act(() => operations.start('Rebuilding search index'))

    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'operation-1', title: 'Rebuilding search index' }),
    )

    await act(() => {
      handle.progress(3, 12)
    })

    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'operation-1', description: '3/12' }),
    )
  })

  it('surfaces failures and closes the toast when the operation clears', async () => {
    const handle = await act(() => operations.start('Saving settings'))
    await act(() => {
      handle.fail('disk full')
    })

    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'operation-1', description: 'disk full', type: 'error' }),
    )

    await act(() => operations.clock.advance(9_200))
    expect(toast.close).toHaveBeenCalledWith('operation-1')
  })

  it('passes optional action metadata to the toast', async () => {
    const run = vi.fn()

    await act(() => {
      operations.start('Update available', { action: { label: 'Install', run }, persistent: true })
    })

    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'operation-1',
        timeout: 0,
        data: { dismissible: false },
      }),
    )

    const options = toast.add.mock.lastCall?.[0]
    expect(options?.actionProps?.children).toBe('Install')
    options?.actionProps?.onClick()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not remove the operation when a toast is dismissed', async () => {
    const handle = await act(() => operations.start('Saving settings'))

    expect(toast.add.mock.lastCall?.[0]?.onClose).toBeUndefined()

    await act(() => {
      handle.fail('disk full')
    })

    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'operation-1', description: 'disk full', type: 'error' }),
    )
  })

  it('consumes rejected action promises', async () => {
    const error = new Error('network down')
    const run = vi.fn(() => Promise.reject(error))
    await act(() => {
      operations.start('Update available', { action: { label: 'Install', run } })
    })

    const options = toast.add.mock.lastCall?.[0]
    options?.actionProps?.onClick()
    await vi.waitFor(() => {
      expect(logger.getErrors()).toEqual([{ message: 'operation action failed:', cause: error }])
    })
  })
})
