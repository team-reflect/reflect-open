import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clickToastAction,
  createTestToastController,
  type TestToastController,
} from '@/test-utils/toast.tsx'
import { showRecordingReminder } from './recording-reminder.ts'

let toasts: TestToastController

beforeEach(() => {
  toasts = createTestToastController()
})

describe('showRecordingReminder', () => {
  it('shows the elapsed time with a stop action', () => {
    const stop = vi.fn()
    showRecordingReminder(toasts, 90 * 60_000, stop)

    const options = toasts.add.mock.lastCall?.[0]
    expect(options?.title).toBe('Still recording')
    expect(options?.description).toBe('1:30:00')
    clickToastAction(options)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('reuses one toast id so reminders replace each other', () => {
    showRecordingReminder(toasts, 30 * 60_000, vi.fn())
    showRecordingReminder(toasts, 60 * 60_000, vi.fn())

    const ids = toasts.add.mock.calls.map(([options]) => options.id)
    expect(new Set(ids).size).toBe(1)
  })
})
