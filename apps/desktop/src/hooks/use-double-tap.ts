import { useLayoutEffect, useRef } from 'react'

const DOUBLE_TAP_MS = 450

/**
 * Double-tap detection over a set of keys: two taps of the same key within
 * `windowMs` pair into a double-tap (keys are compared with `===`). A pending
 * tap only pairs while `activeKey` stays on its key — when the surrounding
 * state moves off it between taps (the mobile tab bar's case: a deep link or
 * an opened note between two tab taps), the second tap reads as a return to
 * the key, not a double-tap, so it starts a fresh pairing instead.
 *
 * @param activeKey The key currently "held" by the surrounding state, or
 *   `null` when none is — watched to expire stranded taps.
 * @returns Record a tap and report whether it completed a double-tap.
 */
export function useDoubleTap<Key>(
  activeKey: Key | null,
  windowMs: number = DOUBLE_TAP_MS,
): (key: Key) => boolean {
  const lastTap = useRef<{ key: Key; at: number } | null>(null)

  useLayoutEffect(() => {
    if (lastTap.current !== null && lastTap.current.key !== activeKey) {
      lastTap.current = null
    }
  }, [activeKey])

  return (key: Key): boolean => {
    const previous = lastTap.current
    const now = Date.now()
    lastTap.current = { key, at: now }
    return previous !== null && previous.key === key && now - previous.at <= windowMs
  }
}
