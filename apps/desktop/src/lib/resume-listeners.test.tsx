import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachResumeListeners } from '@/lib/resume-listeners'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('attachResumeListeners', () => {
  it('collapses the focus and visibility events of one resume into one call', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))

    expect(onResume).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('ignores a visibility change to hidden', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    document.dispatchEvent(new Event('visibilitychange'))

    expect(onResume).not.toHaveBeenCalled()
    dispose()
  })

  it('never dedupes online against a resume that just ran', () => {
    const onResume = vi.fn()
    const dispose = attachResumeListeners(onResume)

    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))

    expect(onResume).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('stops calling after dispose', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const onResume = vi.fn()
    attachResumeListeners(onResume)()

    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))

    expect(onResume).not.toHaveBeenCalled()
  })
})
