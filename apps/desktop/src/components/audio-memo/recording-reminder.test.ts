import { describe, expect, it, vi } from 'vitest'
import { getRecordingReminderToast } from './recording-reminder.ts'

describe('getRecordingReminderToast', () => {
  it('shows the elapsed time with a stop action', () => {
    const stop = vi.fn()
    const spec = getRecordingReminderToast(90 * 60_000, stop)

    expect(spec.title).toBe('Still recording')
    expect(spec.description).toBe('1:30:00')
    spec.action?.run()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('reuses one toast id so reminders replace each other', () => {
    const first = getRecordingReminderToast(30 * 60_000, vi.fn())
    const second = getRecordingReminderToast(60 * 60_000, vi.fn())

    expect(first.id).toBe(second.id)
  })
})
