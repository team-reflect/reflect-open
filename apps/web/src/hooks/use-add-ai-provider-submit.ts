import { useCallback, useState } from 'react'
import { errorMessage, type NewAiProvider } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

interface UseAddAiProviderSubmitOptions {
  /** Persists the new provider (keychain + settings); rejects on failure. */
  onAdd: (draft: NewAiProvider) => Promise<void>
  /** Called after a successful add (close the dialog or sheet). */
  onDone: () => void
}

export interface UseAddAiProviderSubmitValue {
  /** Terminal failure from validation or persistence, shown inline. */
  submitError: string | null
  /**
   * The provider couldn't be reached to verify the key; the next submit
   * saves it unverified (the submit control should say so).
   */
  unverified: boolean
  /** Clear the save-anyway downgrade — the key or provider changed. */
  resetUnverified: () => void
  /** Verify the draft's key against its provider, then persist it. */
  submit: (draft: NewAiProvider) => Promise<void>
}

/**
 * The add-AI-provider submit flow, shared by the desktop dialog and the
 * mobile sheet (Plan 23 — the Plan 22 one-hook-two-shells pattern): verify
 * the key with a live probe first; a rejected key shows inline and stores
 * nothing, an unreachable provider downgrades the next submit to an explicit
 * "save anyway" instead of hard-blocking on connectivity, and a persistence
 * failure surfaces inline with the typed key intact so the user can retry.
 */
export function useAddAiProviderSubmit({
  onAdd,
  onDone,
}: UseAddAiProviderSubmitOptions): UseAddAiProviderSubmitValue {
  const { aiProviderConfig: service } = useCoreServices()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [unverified, setUnverified] = useState(false)

  const resetUnverified = useCallback(() => {
    setUnverified(false)
  }, [])

  const submit = useCallback(
    async (draft: NewAiProvider): Promise<void> => {
      setSubmitError(null)
      try {
        const check = await service.checkDraft(draft, { unverified })
        if (check.status === 'rejected') {
          setSubmitError(check.message)
          return
        }
        if (check.status === 'unreachable') {
          setUnverified(true)
          return
        }
        await onAdd(check.draft)
        onDone()
      } catch (error: unknown) {
        setSubmitError(errorMessage(error))
      }
    },
    [service, unverified, onAdd, onDone],
  )

  return { submitError, unverified, resetUnverified, submit }
}
