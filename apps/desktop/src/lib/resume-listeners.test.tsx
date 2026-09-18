import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachResumeListeners } from '@/lib/resume-listeners'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('attachResumeListeners', () => {
  it('still calls back for the network coming back right after a resume', () => {
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)
    window.dispatchEvent(new Event('focus'))
    onResume.mockClear()

    window.dispatchEvent(new Event('online'))
    vi.runAllTimers()

    expect(onResume).toHaveBeenCalled()
    dispose()
  })

  it('stops calling back after dispose, even with a call still pending', () => {
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    onResume.mockClear()

    dispose()
    vi.runAllTimers()
    window.dispatchEvent(new Event('focus'))

    expect(onResume).not.toHaveBeenCalled()
  })
})
