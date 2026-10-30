import type { ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { useSubscriptionControls } from '@/mobile/use-subscription-controls.ts'
import { SettingsSection } from './section.tsx'

/**
 * Settings → Subscription on the iPad: the plan and the App Store controls
 * App Review requires beside it, the same set the phone's settings list
 * offers (see {@link useSubscriptionControls}). iOS only: the controls read
 * StoreKit through the mobile services, so the settings screen mounts this
 * section only there (see use-visible-settings-sections).
 */
export function SubscriptionSection(): ReactElement {
  const subscriptionControls = useSubscriptionControls()
  return (
    <SettingsSection id="subscription">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text">Plan</div>
          {subscriptionControls.message !== null ? (
            <p className="mt-0.5 text-xs text-text-muted">{subscriptionControls.message}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-sm text-text-secondary">{subscriptionControls.planLabel}</span>
          {subscriptionControls.canSubscribe ? (
            <Button size="sm" onClick={subscriptionControls.subscribe}>
              Subscribe
            </Button>
          ) : subscriptionControls.canManage ? (
            <Button variant="secondary" size="sm" onClick={subscriptionControls.manage}>
              Manage
            </Button>
          ) : null}
        </div>
      </div>
      {subscriptionControls.classicAccount !== null ? (
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">Reflect Classic</div>
            <p className="mt-0.5 truncate text-xs text-text-muted">
              {subscriptionControls.classicAccount}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            disabled={subscriptionControls.removeClassicVerificationPending}
            onClick={subscriptionControls.removeClassicVerification}
          >
            Remove verification
          </Button>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-4 px-4 py-3.5">
        <div className="text-sm font-medium text-text">Purchases</div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={subscriptionControls.redeemPending}
            onClick={() => {
              void subscriptionControls.redeem()
            }}
          >
            Redeem code
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={subscriptionControls.restorePending}
            onClick={() => {
              void subscriptionControls.restore()
            }}
          >
            Restore purchases
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={subscriptionControls.openTerms}
        className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left"
      >
        <span className="text-sm font-medium text-text">Terms of Use</span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-text-muted" />
      </button>
    </SettingsSection>
  )
}
