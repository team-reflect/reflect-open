import { useEffect } from 'react'
import { todayIso } from '@/lib/dates'
import { useRouter } from '@/routing/router'

/**
 * V1's wake-to-today: when the app returns to the foreground on a later
 * calendar date than it was last seen on, navigate to today — open the app,
 * see today. Driven by the document's visibility (WKWebView fires it on
 * background/foreground); an app left *open* across midnight rolls over via
 * `useToday` instead, so this only handles the backgrounded case.
 */
export function useWakeToToday(): void {
  const { navigate } = useRouter()
  useEffect(() => {
    let lastSeen = todayIso()
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') {
        lastSeen = todayIso()
        return
      }
      const now = todayIso()
      if (now !== lastSeen) {
        lastSeen = now
        navigate({ kind: 'today' })
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [navigate])
}
