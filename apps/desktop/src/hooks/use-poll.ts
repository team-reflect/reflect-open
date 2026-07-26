import { useEffect, useRef } from 'react'

/**
 * Run `tick` every `intervalMs` while `enabled`, starting one interval after
 * enablement (callers typically just ran the same check inline). Ticks never
 * overlap — the next wait starts when the previous tick settles — and a tick
 * that throws keeps the loop alive: the network checks this exists for fail
 * transiently. Return 'stop' to end the loop. Disabling or unmounting
 * cancels future ticks but not one already in flight.
 *
 * Polling pauses while the document is hidden — a hidden poll can't show its
 * result, and this hook's consumers exist for flows where the user leaves
 * the app to do something (create a repo, grant access) — and resumes with
 * an *immediate* tick on return to visible: the moment the user comes back
 * is exactly when the polled condition is likeliest to have just become true.
 */
export function usePoll(
  enabled: boolean,
  intervalMs: number,
  tick: () => Promise<'continue' | 'stop'>,
): void {
  // Always call the latest tick without re-arming the timer every render.
  const tickRef = useRef(tick)
  useEffect(() => {
    tickRef.current = tick
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    let stopped = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null

    function settle(result: 'continue' | 'stop'): void {
      inFlight = false
      if (cancelled) {
        return
      }
      if (result === 'stop') {
        stopped = true
        return
      }
      schedule()
    }

    function runTick(): void {
      inFlight = true
      try {
        void tickRef.current().then(settle, () => settle('continue'))
      } catch {
        // A synchronous throw must not strand `inFlight` — that would block
        // the visibility resume forever. Same rule as a rejection.
        settle('continue')
      }
    }

    function schedule(): void {
      if (document.visibilityState === 'hidden') {
        return // paused — the visibility listener resumes with an immediate tick
      }
      timer = setTimeout(() => {
        timer = null
        if (document.visibilityState === 'hidden') {
          return // went hidden in the firing gap; the listener resumes us
        }
        runTick()
      }, intervalMs)
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        return
      }
      // An in-flight tick reschedules itself when it settles, and a pending
      // timer means the loop never paused — only a paused loop resumes here.
      if (!stopped && !inFlight && timer === null) {
        runTick()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule()
    return () => {
      cancelled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, intervalMs])
}
