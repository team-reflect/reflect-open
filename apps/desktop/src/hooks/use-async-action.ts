import { useCallback, useState } from 'react'
import { errorMessage } from '@reflect/core'

export interface AsyncAction {
  /**
   * Run one async action: clears the previous error, flips `pending` for the
   * duration, and captures a failure as a display message instead of letting
   * it escape the event handler.
   */
  run: (action: () => Promise<void>) => Promise<void>
  pending: boolean
  /** The last failure (or validation message via `setError`); null when clean. */
  error: string | null
  /** Surface a message without running anything (pre-submit validation). */
  setError: (message: string | null) => void
}

/**
 * The shared busy/error envelope for button-triggered async work (connect,
 * restore, back-up-now…): every settings action renders the same way — a
 * disabled button while pending and an inline message on failure — so the
 * state machine lives once, here, instead of per component.
 */
export function useAsyncAction(): AsyncAction {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setError(null)
    setPending(true)
    try {
      await action()
    } catch (caught: unknown) {
      setError(errorMessage(caught))
    } finally {
      setPending(false)
    }
  }, [])

  return { run, pending, error, setError }
}
