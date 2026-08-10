import { useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Check } from 'lucide-react'
import { IAP_PRODUCT_IDS, iapGetProducts, iapPurchase, iapRestorePurchases } from '@reflect/core'
import appIcon from '@/assets/app-icon.png'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '@/mobile/legal-urls'
import { invalidateEntitlementQueries } from '@/mobile/use-active-subscription'
import { useSettings } from '@/providers/settings-provider'

/** Which control kicked off the in-flight action (onboarding's PendingChoice
 * pattern): every button disables, only the initiator shows progress. */
type PendingAction = 'monthly' | 'yearly' | 'restore' | null

/** How long "Remind me later" keeps the paywall dismissed. */
const SNOOZE_MS = 24 * 60 * 60 * 1000

export function PaywallScreen(): ReactElement {
  const queryClient = useQueryClient()
  const { updateSettings } = useSettings()
  const [pending, setPending] = useState<PendingAction>(null)
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null)
  const [plan, setPlan] = useState<'monthly' | 'yearly'>('yearly')

  const products = useQuery({
    queryKey: ['iap-products'],
    queryFn: () => iapGetProducts([IAP_PRODUCT_IDS.yearly, IAP_PRODUCT_IDS.monthly]),
  })
  const yearly =
    products.data?.find((product) => product.productId === IAP_PRODUCT_IDS.yearly) ?? null
  const monthly =
    products.data?.find((product) => product.productId === IAP_PRODUCT_IDS.monthly) ?? null
  const productsFailed =
    products.status === 'error' ||
    (products.status === 'success' && (yearly === null || monthly === null))
  const selectedPrice =
    plan === 'yearly'
      ? `${yearly?.formattedPrice ?? ''}/year`
      : `${monthly?.formattedPrice ?? ''}/month`

  const subscribe = async () => {
    const product = plan === 'yearly' ? yearly : monthly
    if (product === null) return
    setPending(plan)
    try {
      await iapPurchase(product.productId)
      // The plugin resolves `purchase` without emitting `purchaseUpdated`
      // (see invalidateEntitlementQueries), so refetch here: the fresh
      // entitlement flips the gate in mobile-app.tsx and unmounts this
      // screen, no navigation needed.
      await invalidateEntitlementQueries(queryClient)
    } catch {
      // Cancelled or failed; the StoreKit sheet already told the user.
    } finally {
      setPending(null)
    }
  }

  const restore = async () => {
    setPending('restore')
    setRestoreMessage(null)
    try {
      const count = await iapRestorePurchases()
      if (count === 0) {
        setRestoreMessage('No previous purchase found for this Apple account.')
      } else {
        await invalidateEntitlementQueries(queryClient)
      }
    } catch {
      setRestoreMessage('Restore failed. Check your connection and try again.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div
      className="flex min-h-dvh w-screen overflow-auto bg-surface-app px-5 text-text"
      style={{
        paddingTop: 'max(env(safe-area-inset-top), 1.5rem)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)',
      }}
    >
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-6">
        <header className="flex flex-col gap-4 pt-2">
          <img src={appIcon} alt="" draggable={false} className="size-11 rounded-xl" />
          <div className="space-y-2">
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
              Unlock Reflect Pro
            </h1>
            <p className="text-sm leading-6 text-text-secondary">
              Notes, tasks, search, and AI. Everything Reflect does on your Mac, now on your iPhone.
            </p>
          </div>
        </header>

        {products.status === 'pending' ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-5" />
          </div>
        ) : null}

        {productsFailed ? (
          <p className="text-sm text-text-muted">
            Could not load subscription options. Check your connection, then{' '}
            <button type="button" className="underline" onClick={() => void products.refetch()}>
              try again
            </button>
            .
          </p>
        ) : null}

        {yearly !== null && monthly !== null ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2.5" role="radiogroup" aria-label="Subscription plan">
              <PlanCard
                title="Yearly"
                price={`${yearly.formattedPrice ?? ''} / year`}
                badge="Best value"
                selected={plan === 'yearly'}
                disabled={pending !== null}
                onSelect={() => setPlan('yearly')}
              />
              <PlanCard
                title="Monthly"
                price={`${monthly.formattedPrice ?? ''} / month`}
                selected={plan === 'monthly'}
                disabled={pending !== null}
                onSelect={() => setPlan('monthly')}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Button
                className="h-12 rounded-xl text-base"
                disabled={pending !== null}
                onClick={() => void subscribe()}
              >
                {pending === 'monthly' || pending === 'yearly' ? (
                  <Spinner className="size-4" />
                ) : null}
                Start 7-day free trial
              </Button>
              <p className="text-center text-xs leading-5 text-text-muted">
                7 days free, then {selectedPrice}.
                <br />
                Cancel anytime in the App Store.
              </p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col items-center gap-4">
          {/* First-rollout escape hatch: dismissing writes a snooze timestamp
              and the gate in mobile-app.tsx unmounts this screen, so a broken
              store never locks anyone out of their notes. */}
          <button
            type="button"
            className="text-sm text-text-muted underline disabled:opacity-50"
            disabled={pending !== null}
            onClick={() => updateSettings({ paywallSnoozeUntil: Date.now() + SNOOZE_MS })}
          >
            Remind me later
          </button>
          <button
            type="button"
            className="text-sm text-text-muted underline disabled:opacity-50"
            disabled={pending !== null}
            onClick={() => void restore()}
          >
            {pending === 'restore' ? 'Restoring…' : 'Restore Purchases'}
          </button>
          {restoreMessage !== null ? (
            <p className="text-center text-sm text-text-muted">{restoreMessage}</p>
          ) : null}
        </div>

        <footer className="mt-auto flex justify-center gap-4 text-[13px] text-text-muted">
          <button
            type="button"
            className="underline"
            onClick={() => void openUrl(TERMS_OF_USE_URL).catch(() => {})}
          >
            Terms of Use
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => void openUrl(PRIVACY_POLICY_URL).catch(() => {})}
          >
            Privacy Policy
          </button>
        </footer>
      </div>
    </div>
  )
}

interface PlanCardProps {
  title: string
  price: string
  badge?: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}

function PlanCard({
  title,
  price,
  badge,
  selected,
  disabled,
  onSelect,
}: PlanCardProps): ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex items-center gap-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-50',
        selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border bg-surface',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
        )}
      >
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      <span className="flex flex-1 flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-sm text-text-secondary">{price}</span>
      </span>
      {badge !== undefined ? (
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {badge}
        </span>
      ) : null}
    </button>
  )
}
