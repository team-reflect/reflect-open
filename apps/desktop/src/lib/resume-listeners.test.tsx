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
  it('calls back right away when the window regains focus', () => {
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    window.dispatchEvent(new Event('focus'))

    expect(onResume).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('calls back right away when the document becomes visible', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    document.dispatchEvent(new Event('visibilitychange'))

    expect(onResume).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('calls back right away when the network comes back', () => {
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    window.dispatchEvent(new Event('online'))

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

  it('answers a burst of events once now and once after the burst', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    expect(onResume).toHaveBeenCalledTimes(1)

    // The network came back after the first call already ran offline, so the
    // burst still ends with a call that sees it.
    vi.runAllTimers()
    expect(onResume).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('stops calling after dispose, even with a call still pending', () => {
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    expect(onResume).toHaveBeenCalledTimes(1)

    dispose()
    vi.runAllTimers()
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))

    expect(onResume).toHaveBeenCalledTimes(1)
  })
})
