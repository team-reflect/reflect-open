import { useEffect } from 'react'

/**
 * Reports a form's in-flight submit up to the dialog or sheet that hosts it,
 * so the host can refuse to be dismissed while the submit would still land.
 * Unmounting reports `false`: a success closes the host before the submit
 * settles, and the lock must not outlive the form.
 */
export function useReportPending(
  pending: boolean,
  onPendingChange: (pending: boolean) => void,
): void {
  useEffect(() => {
    onPendingChange(pending)
    return () => onPendingChange(false)
  }, [pending, onPendingChange])
}
