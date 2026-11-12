import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clickToastAction,
  createTestToastController,
  type TestToastController,
} from '@/test-utils/toast.tsx'
import { showRecordingReminder } from './recording-reminder.ts'

let toastController: TestToastController

beforeEach(() => {
  toastController = createTestToastController()
})

describe('showRecordingReminder', () => {
  it('shows the elapsed time with a stop action', () => {
    const stop = vi.fn()
    showRecordingReminder(toastController, 90 * 60_000, stop)

    const options = toastController.add.mock.lastCall?.[0]
    expect(options?.title).toBe('Still recording')
    expect(options?.description).toBe('1:30:00')
    clickToastAction(options)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('reuses one toast id so reminders replace each other', () => {
    showRecordingReminder(toastController, 30 * 60_000, vi.fn())
    showRecordingReminder(toastController, 60 * 60_000, vi.fn())

    const ids = toastController.add.mock.calls.map(([options]) => options.id)
    expect(new Set(ids).size).toBe(1)
  })
})
