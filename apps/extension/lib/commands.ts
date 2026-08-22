/** Chrome command id for opening the capture popup for the active page. */
export const SAVE_CURRENT_PAGE_COMMAND = 'save-current-page'

export type OpenCaptureCommandOutcome = 'popup' | 'fallback-capture'

/**
 * Open the action popup for the keyboard command. Chrome before 127 does not
 * expose `action.openPopup`, so retain the old instant-capture behavior as a
 * compatibility fallback.
 */
export async function openCapturePopupOrFallback(
  openPopup: (() => Promise<void>) | undefined,
  fallbackCapture: () => Promise<void>,
): Promise<OpenCaptureCommandOutcome> {
  if (openPopup) {
    try {
      await openPopup()
      return 'popup'
    } catch {
      // A browser that exposes but rejects openPopup still gets a capture.
    }
  }
  await fallbackCapture()
  return 'fallback-capture'
}
