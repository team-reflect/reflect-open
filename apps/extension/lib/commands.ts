/** Chrome command id for opening the capture popup for the active page. */
export const SAVE_CURRENT_PAGE_COMMAND = 'save-current-page'

/** Whether the shortcut opened the popup or used the legacy instant-capture path. */
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
    await openPopup()
    return 'popup'
  }
  await fallbackCapture()
  return 'fallback-capture'
}
