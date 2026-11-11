import { usePaywallRequested } from '@/hooks/use-paywall-requested.ts'
import { formatFullDate } from '@reflect/core'
import { TERMS_OF_USE_URL } from '@/mobile/legal-urls.ts'
import { useActiveSubscription } from '@/mobile/use-active-subscription.ts'
import { useIapRestoreRedeem } from '@/mobile/use-iap-restore-redeem.ts'
import {
  classicAccessMessage,
  useClassicAccess,
  useClassicSignOut,
} from '@/mobile/use-classic-access.ts'
import { useDateFormat } from '@/providers/settings-provider.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * The iOS app's subscription state and the controls App Review requires
 * beside it (restore, manage, redeem, terms), in one hook so every settings
 * surface offers the same set. Actions are function properties so rows can
 * take them unbound.
 */
export interface SubscriptionControls {
  /** The plan as one line: Monthly, Yearly, a Reflect Classic grant, or none. */
  readonly planLabel: string
  /**
   * No App Store plan and no active Classic grant, so offer the paywall. Also
   * true while the lookup is still loading and the plan reads "Checking…".
   */
  readonly canSubscribe: boolean
  /** An App Store subscription the system's account page can manage. */
  readonly canManage: boolean
  /** The verified Reflect Classic account's email, when a grant exists. */
  readonly classicAccount: string | null
  /** The latest action's outcome, or the Classic grant's status. */
  readonly message: string | null
  readonly restorePending: boolean
  readonly redeemPending: boolean
  readonly removeClassicVerificationPending: boolean
  /** Opens the paywall drawer over the app; it stays open until a purchase. */
  subscribe: () => void
  manage: () => void
  restore: () => void
  redeem: () => void
  removeClassicVerification: () => void
  openTerms: () => void
}

export function useSubscriptionControls(): SubscriptionControls {
  const subscription = useActiveSubscription()
  const classicAccess = useClassicAccess()
  const classicSignOut = useClassicSignOut()
  const { opener } = useAppServices()
  const dateFormat = useDateFormat()
  const [, setPaywallRequested] = usePaywallRequested()
  const iap = useIapRestoreRedeem()

  const planLabel =
    subscription.value === 'monthly'
      ? 'Monthly'
      : subscription.value === 'yearly'
        ? 'Yearly'
        : classicAccess.active && classicAccess.value !== null
          ? `Reflect Classic, until ${formatFullDate(new Date(classicAccess.value.expiresAt), dateFormat)}`
          : subscription.isLoading || classicAccess.isLoading
            ? 'Checking…'
            : 'Not subscribed'

  return {
    planLabel,
    canSubscribe: subscription.value === null && !classicAccess.active,
    canManage: subscription.value !== null,
    classicAccount: classicAccess.value === null ? null : (classicAccess.value.email ?? 'Unknown'),
    message: iap.restoreFeedback ?? iap.redeemFeedback ?? classicAccessMessage(classicAccess),
    restorePending: iap.restoreMutation.isPending,
    redeemPending: iap.redeemMutation.isPending,
    removeClassicVerificationPending: classicSignOut.isPending,
    // The request opens the paywall drawer over the app, also outside the App
    // Store. It is skippable unless the free period has ended.
    subscribe: () => {
      setPaywallRequested(true)
    },
    manage: () => {
      opener.openUrlSync('https://apps.apple.com/account/subscriptions')
    },
    restore: iap.restore,
    redeem: iap.redeem,
    removeClassicVerification: () => {
      classicSignOut.mutate()
    },
    openTerms: () => {
      opener.openUrlSync(TERMS_OF_USE_URL)
    },
  }
}
