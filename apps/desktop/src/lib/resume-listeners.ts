/**
 * A single foreground/resume transition fires several DOM events at once:
 * WKWebView emits both `visibilitychange` and `focus` on app resume, desktop
 * unminimize can too. Triggers inside this window collapse into one call.
 */
const RESUME_DEDUPE_MS = 1_500

/**
 * Call `onResume` when the user comes back to this window or the network comes
 * back: `focus` for a desktop refocus, visibility → visible for mobile resume
 * and desktop unminimize (which doesn't reliably fire `focus`), and `online`.
 * `online` is never deduped: a resume just before it ran while still offline.
 * Returns the disposer.
 */
export function attachResumeListeners(onResume: () => void): () => void {
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
  window.addEventListener('online', onResume)
  return () => {
    window.removeEventListener('focus', resume)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('online', onResume)
  }
}
