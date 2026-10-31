import { useRef, useState } from 'react'

const UNLOCK_TAP_COUNT = 10
const UNLOCK_TAP_GAP_MS = 500

/**
 * Ten quick taps on the app version field reveal the settings debug actions
 * (the build-number-tap trick), in any build, production included. The unlock
 * is plain component state, so leaving the screen re-hides it.
 */
export function useDebugUnlockTap(): { unlocked: boolean; tap: () => void } {
  const [unlocked, setUnlocked] = useState(false)
  const tapsRef = useRef({ count: 0, lastMs: 0 })
  return {
    unlocked,
    tap: () => {
      const now = Date.now()
      const taps = tapsRef.current
      taps.count = now - taps.lastMs <= UNLOCK_TAP_GAP_MS ? taps.count + 1 : 1
      taps.lastMs = now
      if (taps.count >= UNLOCK_TAP_COUNT) {
        setUnlocked(true)
      }
    },
  }
}

/**
 * Crashes the UI on purpose so the error boundary can be exercised by hand.
 * The throw happens in the next render, not in the returned trigger: only
 * render-phase errors reach an error boundary.
 */
export function useCrashTest(): () => void {
  const [armed, setArmed] = useState(false)
  if (armed) {
    throw new Error('Crash test: triggered from the settings debug actions')
  }
  return () => {
    setArmed(true)
  }
}
