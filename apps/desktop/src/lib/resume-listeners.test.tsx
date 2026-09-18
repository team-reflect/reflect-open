import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachResumeListeners } from '@/lib/resume-listeners'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('attachResumeListeners', () => {
  it('calls back after the window regains focus', () => {
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    window.dispatchEvent(new Event('focus'))
    vi.runAllTimers()

    expect(onResume).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('calls back after the document becomes visible', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    document.dispatchEvent(new Event('visibilitychange'))
    vi.runAllTimers()

    expect(onResume).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('calls back after the network comes back', () => {
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    window.dispatchEvent(new Event('online'))
    vi.runAllTimers()

    expect(onResume).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('ignores a visibility change to hidden', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    document.dispatchEvent(new Event('visibilitychange'))
    vi.runAllTimers()

    expect(onResume).not.toHaveBeenCalled()
    dispose()
  })

  it('answers a burst of events with one call, after the last of them', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    // The network is back by the time the call runs, so it is never stuck
    // with the result of a run that started offline.
    window.dispatchEvent(new Event('online'))
    expect(onResume).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(onResume).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('stops calling after dispose, even with a call still pending', () => {
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)
    window.dispatchEvent(new Event('focus'))

    dispose()
    vi.runAllTimers()
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    vi.runAllTimers()

    expect(onResume).not.toHaveBeenCalled()
  })
})
