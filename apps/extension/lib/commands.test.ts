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

  it('falls back only when openPopup is unavailable', async () => {
    const fallbackCapture = vi.fn().mockResolvedValue(undefined)

    await expect(openCapturePopupOrFallback(undefined, fallbackCapture)).resolves.toBe(
      'fallback-capture',
    )
    expect(fallbackCapture).toHaveBeenCalledOnce()
  })

  it('does not silently capture when an available openPopup call is rejected', async () => {
    const popupFailure = new Error('the popup is already open')
    const openPopup = vi.fn().mockRejectedValue(popupFailure)
    const fallbackCapture = vi.fn().mockResolvedValue(undefined)

    await expect(openCapturePopupOrFallback(openPopup, fallbackCapture)).rejects.toBe(popupFailure)
    expect(fallbackCapture).not.toHaveBeenCalled()
  })
})
