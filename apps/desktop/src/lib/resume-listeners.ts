import { throttle } from '@ocavue/utils'

const RESUME_THROTTLE_MS = 500

/**
 * Call `onResume` when the user comes back to this window or the network comes
 * back. Returns the disposer.
 */
export function attachResumeListeners(onResume: () => void): () => void {
  let canceled = false
  const handleResume = throttle(
    (): void => {
      if (!canceled) {
        onResume()
      }
    },
    RESUME_THROTTLE_MS,
    { leading: false },
  )
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
