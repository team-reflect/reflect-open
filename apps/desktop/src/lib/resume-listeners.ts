import { throttle } from "@ocavue/utils"

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
let canceled = false
  const resumeThrottle = throttle(onResume, RESUME_DEDUPE_MS)

  const handleResume = (): void => {
    if (canceled) {return }
    resumeThrottle()
  }
  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      handleResume()
    }
  }
  window.addEventListener('focus', handleResume)
  window.addEventListener('online', handleResume)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  return () => {
    canceled = true
    window.removeEventListener('focus', handleResume)
    window.removeEventListener('online', handleResume)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}
