import { useCallback, useState } from 'react'

interface SwipeTargetState {
  readonly navigationKey: string
  readonly date: string | null
}

export interface SwipeTarget {
  /** The day an in-flight swipe is heading toward, or `null` when settled. */
  targetDate: string | null
  /**
   * Follow a swipe's pointer-up target. Tagged with the arrival that produced
   * it: an update from a superseded arrival (a transition applying after a
   * newer Today/strip/history navigation) is ignored.
   */
  followSwipeTarget: (date: string, sourceNavigationKey: string) => void
}

/**
 * The calendar strip's optimistic day: a swipe's destination announced at
 * pointer-up, followed while the snap animation plays instead of waiting for
 * the settle-time route change (extracted from MobileDaily).
 *
 * The target is scoped to the router arrival that created it. Any new arrival
 * — the swipe's own settle, a Today tap, a strip tap, history — changes
 * `navigationKey` and clears the target during render, so stale transition
 * state never reaches a frame; a stale `followSwipeTarget` from the old
 * arrival cannot restore it.
 */
export function useSwipeTarget(navigationKey: string): SwipeTarget {
  const [swipeTarget, setSwipeTarget] = useState<SwipeTargetState>(() => ({
    navigationKey,
    date: null,
  }))
  if (swipeTarget.navigationKey !== navigationKey) {
    setSwipeTarget({ navigationKey, date: null })
  }
  const followSwipeTarget = useCallback((date: string, sourceNavigationKey: string): void => {
    setSwipeTarget((current) =>
      current.navigationKey === sourceNavigationKey ? { ...current, date } : current,
    )
  }, [])
  return { targetDate: swipeTarget.date, followSwipeTarget }
}
