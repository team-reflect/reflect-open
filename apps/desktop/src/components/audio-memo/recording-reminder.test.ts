import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MockToastAddOptions } from '@/test-utils/toast'
import { showRecordingReminder } from './recording-reminder'

const toast = vi.hoisted(() => ({
  add: vi.fn<(options: MockToastAddOptions) => string>(),
  close: vi.fn(),
}))

vi.mock('@/components/ui/toast', () => ({ toast }))

afterEach(() => {
  toast.add.mockClear()
})

describe('showRecordingReminder', () => {
  it('shows the elapsed time with a stop action', () => {
    const stop = vi.fn()
    showRecordingReminder(90 * 60_000, stop)

    const options = toast.add.mock.lastCall?.[0]
    expect(options?.title).toBe('Still recording')
    expect(options?.description).toBe('1:30:00')
    options?.actionProps?.onClick()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('reuses one toast id so reminders replace each other', () => {
    showRecordingReminder(30 * 60_000, vi.fn())
    showRecordingReminder(60 * 60_000, vi.fn())

    const ids = toast.add.mock.calls.map(([options]) => options.id)
    expect(new Set(ids).size).toBe(1)
  })
})
