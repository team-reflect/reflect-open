import type { ClockService, TimerHandle } from '@reflect/core'
import { createDeferred } from '@reflect/utils'
import type { AppLifecycleService } from '../app/lifecycle-service.ts'

export interface PollUntilOptions {
  /**
   * The wait before each check.
   */
  readonly intervalMs: number
  readonly clock: ClockService
  readonly lifecycle: AppLifecycleService
  /**
   * Aborting it rejects the returned promise with `signal.reason`.
   */
  readonly signal: AbortSignal
}

/**
 * Run `check` every `intervalMs` until `isDone` accepts its value, and resolve
 * with that value. The first check comes one interval from now. Checks never
 * overlap, and a check that throws counts as not done.
 *
 * Polling pauses while the document is hidden and resumes with an immediate
 * check when it is visible again.
 */
export async function pollUntil<T>(
  check: () => Promise<T>,
  isDone: (value: T) => boolean,
  options: PollUntilOptions,
): Promise<T> {
  const { signal } = options
  for (;;) {
    await waitForNextCheck(options)
    let value: T
    try {
      value = await check()
    } catch {
      signal.throwIfAborted()
      continue
    }
    signal.throwIfAborted()
    if (isDone(value)) {
      return value
    }
  }
}

/**
 * Resolve after `intervalMs` of visible time, or on the first visible event
 * after the document was hidden.
 */
function waitForNextCheck({
  intervalMs,
  clock,
  lifecycle,
  signal,
}: PollUntilOptions): Promise<void> {
  signal.throwIfAborted()
  const { promise, resolve, reject } = createDeferred<void>()
  const cleanup = new AbortController()
  let timer: TimerHandle | null = null
  const clearTimer = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }
  const removeHidden = lifecycle.subscribeHidden(clearTimer)
  const removeVisible = lifecycle.subscribeVisible(() => {
    // A pending timer means the wait never paused.
    if (timer === null) {
      finish()
      resolve()
    }
  })
  const finish = (): void => {
    clearTimer()
    removeHidden()
    removeVisible()
    cleanup.abort()
  }
  signal.addEventListener(
    'abort',
    () => {
      finish()
      reject(signal.reason)
    },
    { signal: cleanup.signal },
  )
  if (!lifecycle.isHidden()) {
    timer = clock.setTimeout(() => {
      timer = null
      // Went hidden in the firing gap: the visible listener resumes.
      if (!lifecycle.isHidden()) {
        finish()
        resolve()
      }
    }, intervalMs)
  }
  return promise
}
