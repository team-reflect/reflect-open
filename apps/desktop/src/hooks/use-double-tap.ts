import { useLayoutEffect, useRef } from 'react'

const DOUBLE_TAP_MS = 450

/** How a tap relates to the active key it is recorded against. */
export interface DoubleTapOptions {
  /**
   * The tap's own navigation moves the active key off its key (the mobile
   * All tab returning to an open Chat or note), so that one move must not
   * expire it.
   */
  leavesKey?: boolean
}

/**
 * Double-tap detection over a set of keys: two taps of the same key within
 * `windowMs` pair into a double-tap (keys are compared with `===`). A pending
 * tap only pairs while `activeKey` stays on its key — when the surrounding
 * state moves off it between taps (the mobile tab bar's case: a deep link or
 * an opened note between two tab taps), the second tap reads as a return to
 * the key, not a double-tap, so it starts a fresh pairing instead. A tap
 * recorded with `leavesKey` is forgiven the first such move, which is its
 * own.
 *
 * @param activeKey The key currently "held" by the surrounding state, or
 *   `null` when none is — watched to expire stranded taps.
 * @returns Record a tap and report whether it completed a double-tap.
 */
export function useDoubleTap<Key>(
  activeKey: Key | null,
  windowMs: number = DOUBLE_TAP_MS,
): (key: Key, options?: DoubleTapOptions) => boolean {
  const lastTapRef = useRef<{ key: Key; at: number; leavesKey: boolean } | null>(null)

  useLayoutEffect(() => {
    const lastTap = lastTapRef.current
    if (lastTap === null || lastTap.key === activeKey) {
      return
    }
    lastTapRef.current = lastTap.leavesKey ? { ...lastTap, leavesKey: false } : null
  }, [activeKey])

  return (key: Key, options?: DoubleTapOptions): boolean => {
    const previous = lastTapRef.current
    const now = Date.now()
    lastTapRef.current = { key, at: now, leavesKey: options?.leavesKey ?? false }
    return previous !== null && previous.key === key && now - previous.at <= windowMs
  }
}
