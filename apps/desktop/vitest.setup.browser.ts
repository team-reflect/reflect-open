// Setup for the browser-mode vitest project. Loads the app's real stylesheet so
// visibility and layout assertions behave like the shipped app, and registers
// the `locate(selector)` locator extension.
import '@/styles/index.css'

import '@/test-utils/locator'

// virtua's resize tracking trips Chromium's benign "ResizeObserver loop
// completed with undelivered notifications" error. It is a notification-timing
// warning, not a real failure, but vitest's browser error catcher would
// otherwise attribute it to whatever test is running. Swallow just that message.
window.addEventListener(
  'error',
  (event) => {
    if (event.message.includes('ResizeObserver loop')) {
      event.stopImmediatePropagation()
      event.preventDefault()
    }
  },
  true,
)
