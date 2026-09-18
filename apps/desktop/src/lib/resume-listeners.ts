/**
 * A single foreground/resume transition fires several DOM events at once:
 * WKWebView emits both `visibilitychange` and `focus` on app resume, desktop
 * unminimize can too. Triggers inside this window collapse into one call.
 */
const RESUME_DEDUPE_MS = 1_500

/**
 * Call `onResume` when the user comes back to this window: `focus` for a
 * desktop refocus, visibility → visible for mobile resume and desktop
 * unminimize (which doesn't reliably fire `focus`). Returns the listeners'
 * disposers.
 */
export function attachResumeListeners(onResume: () => void): Array<() => void> {
  let lastResumeAt = 0
  const resume = (): void => {
    const now = Date.now()
    if (now - lastResumeAt < RESUME_DEDUPE_MS) {
      return
    }
    lastResumeAt = now
    onResume()
  }
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      resume()
    }
  }
  window.addEventListener('focus', resume)
  document.addEventListener('visibilitychange', onVisibilityChange)
  return [
    () => window.removeEventListener('focus', resume),
    () => document.removeEventListener('visibilitychange', onVisibilityChange),
  ]
}
