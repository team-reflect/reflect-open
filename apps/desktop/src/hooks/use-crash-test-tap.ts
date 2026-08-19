import { useRef, useState } from 'react'

const CRASH_TAP_COUNT = 10
const CRASH_TAP_GAP_MS = 500

/**
 * Ten quick taps on the app version field crash the UI on purpose, so the
 * error boundary can be exercised by hand in any build, production included
 * (the build-number-tap trick). The throw happens in the next render, not in
 * the tap handler: only render-phase errors reach an error boundary.
 */
export function useCrashTestTap(): () => void {
  const [armed, setArmed] = useState(false)
  const tapsRef = useRef({ count: 0, lastMs: 0 })
  if (armed) {
    throw new Error('Crash test: the version field was tapped 10 times')
  }
  return () => {
    const now = Date.now()
    const taps = tapsRef.current
    taps.count = now - taps.lastMs <= CRASH_TAP_GAP_MS ? taps.count + 1 : 1
    taps.lastMs = now
    if (taps.count >= CRASH_TAP_COUNT) {
      setArmed(true)
    }
  }
}
