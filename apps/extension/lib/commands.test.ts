import { describe, expect, it, vi } from 'vitest'
import { openCapturePopupOrFallback } from './commands'

describe('openCapturePopupOrFallback', () => {
  it('opens the action popup without taking the legacy capture path', async () => {
    const openPopup = vi.fn().mockResolvedValue(undefined)
    const fallbackCapture = vi.fn().mockResolvedValue(undefined)

    await expect(openCapturePopupOrFallback(openPopup, fallbackCapture)).resolves.toBe('popup')
    expect(openPopup).toHaveBeenCalledOnce()
    expect(fallbackCapture).not.toHaveBeenCalled()
  })

  it('falls back when openPopup is unavailable or rejected', async () => {
    const fallbackCapture = vi.fn().mockResolvedValue(undefined)

    await expect(openCapturePopupOrFallback(undefined, fallbackCapture)).resolves.toBe(
      'fallback-capture',
    )
    expect(fallbackCapture).toHaveBeenCalledOnce()

    const rejectedPopup = vi.fn().mockRejectedValue(new Error('not supported'))
    await expect(openCapturePopupOrFallback(rejectedPopup, fallbackCapture)).resolves.toBe(
      'fallback-capture',
    )
    expect(fallbackCapture).toHaveBeenCalledTimes(2)
  })
})
