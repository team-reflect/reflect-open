import { useCallback, useMemo } from 'react'
import { useMutation, type UseMutationResult } from '@tanstack/react-query'
import type { ActiveSubscription } from '@reflect/core'
import { mutationKeys, mutationScopeIds } from '@/lib/query-client.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'

export interface IapRestoreRedeem {
  readonly restoreMutation: UseMutationResult<ActiveSubscription, Error, void>
  readonly redeemMutation: UseMutationResult<void, Error, void>
  /** The restore's outcome when it failed or found nothing, else `null`. */
  readonly restoreFeedback: string | null
  /** The redemption sheet's failure, else `null`. */
  readonly redeemFeedback: string | null
  /** Clear the redeem outcome, then restore. */
  restore: () => void
  /** Clear the restore outcome, then present the redemption sheet. */
  redeem: () => void
}

/**
 * The App Store's restore and redeem actions, shared by the paywall and the
 * settings screen. Both run in the IAP scope, so they queue behind any other
 * IAP action. Starting one resets the other, which also detaches it, so a
 * late result never replaces the newer action's message.
 */
export function useIapRestoreRedeem(): IapRestoreRedeem {
  const { paywall } = useMobileServices()
  const restoreMutation = useMutation({
    mutationKey: mutationKeys.iap.restore,
    scope: { id: mutationScopeIds.iapAction },
    mutationFn: () => paywall.restore(),
  })
  const redeemMutation = useMutation({
    mutationKey: mutationKeys.iap.redeem,
    scope: { id: mutationScopeIds.iapAction },
    mutationFn: () => paywall.redeemCode(),
  })
  const restoreFeedback = restoreMutation.isError
    ? 'Restore failed. Check your connection and try again.'
    : restoreMutation.data === null
      ? 'No previous purchase found for this Apple account.'
      : null
  const redeemFeedback = redeemMutation.isError
    ? 'Could not open the redemption sheet. Try again.'
    : null

  const { reset: resetRestore, mutate: startRestore } = restoreMutation
  const { reset: resetRedeem, mutate: startRedeem } = redeemMutation
  const restore = useCallback(() => {
    resetRedeem()
    startRestore()
  }, [resetRedeem, startRestore])
  const redeem = useCallback(() => {
    resetRestore()
    startRedeem()
  }, [resetRestore, startRedeem])

  return useMemo(
    () => ({ restoreMutation, redeemMutation, restoreFeedback, redeemFeedback, restore, redeem }),
    [restoreMutation, redeemMutation, restoreFeedback, redeemFeedback, restore, redeem],
  )
}
