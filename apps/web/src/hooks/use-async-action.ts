import type { MaybePromise } from '@reflect/utils'
import { useCallback, useMemo, useRef, useState } from 'react'
import { errorMessage } from '@reflect/core'

export interface AsyncAction {
  /**
   * Run one async action: clears the previous error, flips `pending` for the
   * duration, and captures a failure as a display message instead of letting
   * it escape the event handler. A call made while another is still running
   * is ignored. Never rejects; resolves `true` when the action ran (whether
   * it succeeded or failed) and `false` when it was skipped.
   */
  run: (action: () => MaybePromise<void>) => Promise<boolean>
  pending: boolean
  /** The last failure; null when clean. Throw from the action to show a validation message. */
  error: string | null
  /** Clear the error without running anything, e.g. when a reused dialog closes. */
  reset: () => void
}

/**
 * The shared busy/error envelope for button-triggered async work (connect,
 * restore, back-up-now…): every action renders the same way, a disabled
 * button while pending and an inline message on failure, so the state machine
 * lives once, here, instead of per component.
 */
export function useAsyncAction(): AsyncAction {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set synchronously in the handler, so a second click in the same frame
  // (before `disabled={pending}` has rendered) is still rejected.
  const inFlightRef = useRef(false)

  const run = useCallback(async (action: () => MaybePromise<void>): Promise<boolean> => {
    if (inFlightRef.current) {
      return false
    }
    inFlightRef.current = true
    setError(null)
    setPending(true)
    try {
      await action()
    } catch (caught: unknown) {
      setError(errorMessage(caught))
    }
    // The catch swallows everything, so this always runs. No `finally`: the
    // React Compiler skips any function that has one.
    inFlightRef.current = false
    setPending(false)
    return true
  }, [])

  const reset = useCallback((): void => {
    setError(null)
  }, [])

  return useMemo(() => ({ run, pending, error, reset }), [run, pending, error, reset])
}
