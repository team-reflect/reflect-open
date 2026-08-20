import { useState, type ReactElement } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { toast } from '@/components/ui/toast'
import { IAP_PRODUCT_IDS, iapGetProducts, iapPurchase, iapRestorePurchases } from '@reflect/core'
import appIcon from '@/assets/app-icon.png'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { openUrlSync } from '@/lib/open-url'
import { mutationKeys, mutationScopeIds, queryKeys } from '@/lib/query-client'
import { cn } from '@/lib/utils'
import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '@/mobile/legal-urls'
import { useActiveSubscription } from '@/mobile/use-active-subscription'
import { useSettings } from '@/providers/settings-provider'

type PurchasePlan = 'monthly' | 'yearly'

interface PurchaseVariables {
  plan: PurchasePlan
  productId: string
}

function purchaseProduct(variables: PurchaseVariables): Promise<void> {
  return iapPurchase(variables.productId)
}

/** How long "Remind me later" keeps the paywall dismissed. */
const SNOOZE_MS = 24 * 60 * 60 * 1000

/** How long the member button keeps the paywall dismissed while the
 * free-year claim flow is not live yet. */
const MEMBER_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000

/** V1 web page that hands a paying Reflect member their free-year offer code. */
const CLAIM_FREE_YEAR_URL = 'https://reflect.app/claim-reflect-open'

/** When the free-week stopgap self-expires (30 days after it was written,
 * 2026-08-12). After this the member button opens the claim page instead. */
const MEMBER_STOPGAP_UNTIL = Date.parse('2026-09-11')

export function PaywallScreen(): ReactElement {
  const subscription = useActiveSubscription()
  const { updateSettings } = useSettings()
  const [selectedPlan, setSelectedPlan] = useState<PurchasePlan>('yearly')

  const products = useQuery({
    queryKey: queryKeys.iap.products,
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
    selectedPlan === 'yearly'
      ? `${yearly?.formattedPrice ?? ''}/year`
      : `${monthly?.formattedPrice ?? ''}/month`

  const purchaseMutation = useMutation({
    mutationKey: mutationKeys.iap.purchase,
    scope: { id: mutationScopeIds.iapAction },
    mutationFn: purchaseProduct,
    onSuccess: subscription.invalidate,
  })
  const restoreMutation = useMutation({
    mutationKey: mutationKeys.iap.restore,
    scope: { id: mutationScopeIds.iapAction },
    mutationFn: iapRestorePurchases,
    onSuccess: (count) => {
      if (count > 0) {
        subscription.invalidate()
      }
    },
  })
  const actionPending = purchaseMutation.isPending || restoreMutation.isPending
  const purchasingPlan = purchaseMutation.isPending
    ? (purchaseMutation.variables?.plan ?? null)
    : null
  const restoreFeedback = restoreMutation.isError
    ? 'Restore failed. Check your connection and try again.'
    : restoreMutation.data === 0
      ? 'No previous purchase found for this Apple account.'
      : null

  const subscribe = () => {
    const product = selectedPlan === 'yearly' ? yearly : monthly
    if (product === null) return
    restoreMutation.reset()
    purchaseMutation.mutate({ plan: selectedPlan, productId: product.productId })
  }

  // Stopgap while reflect.app/claim-reflect-open is not live: members get a
  // week free and the paywall asks again when it lapses. The toast outlives
  // this screen (its Toaster mounts in mobile-root.tsx, outside the gate),
  // and the snooze write unmounts the paywall immediately. Past the stopgap
  // deadline the button opens the claim page, so a stale build stops handing
  // out free weeks once the real flow exists.
  const memberContinue = () => {
    if (Date.now() > MEMBER_STOPGAP_UNTIL) {
      openUrlSync(CLAIM_FREE_YEAR_URL)
      return
    }
    toast.add({
      title: 'Enjoy Reflect free for now',
      description: "We'll ask about your free year again once codes are ready.",
      timeout: 6000,
    })
    updateSettings({ paywallSnoozeUntil: Date.now() + MEMBER_SNOOZE_MS })
  }

  const restore = () => {
    purchaseMutation.reset()
    restoreMutation.mutate()
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
                selected={selectedPlan === 'yearly'}
                disabled={actionPending}
                onSelect={() => setSelectedPlan('yearly')}
              />
              <PlanCard
                title="Monthly"
                price={`${monthly.formattedPrice ?? ''} / month`}
                selected={selectedPlan === 'monthly'}
                disabled={actionPending}
                onSelect={() => setSelectedPlan('monthly')}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Button
                className="h-12 rounded-xl text-base"
                disabled={actionPending}
                onClick={subscribe}
              >
                {purchasingPlan !== null ? <Spinner className="size-4" /> : null}
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
          <button
            type="button"
            className="text-sm text-text-secondary underline disabled:opacity-50"
            disabled={actionPending}
            onClick={memberContinue}
          >
            Already a Reflect member? Get your first year free
          </button>
          {/* First-rollout escape hatch: dismissing writes a snooze timestamp
              and the gate in mobile-app.tsx unmounts this screen, so a broken
              store never locks anyone out of their notes. */}
          <button
            type="button"
            className="text-sm text-text-muted underline disabled:opacity-50"
            disabled={actionPending}
            onClick={() => updateSettings({ paywallSnoozeUntil: Date.now() + SNOOZE_MS })}
          >
            Remind me later
          </button>
          <button
            type="button"
            className="text-sm text-text-muted underline disabled:opacity-50"
            disabled={actionPending}
            onClick={restore}
          >
            {restoreMutation.isPending ? 'Restoring…' : 'Restore Purchases'}
          </button>
          {restoreFeedback !== null ? (
            <p className="text-center text-sm text-text-muted">{restoreFeedback}</p>
          ) : null}
        </div>

        <footer className="mt-auto flex justify-center gap-4 text-[13px] text-text-muted">
          <button type="button" className="underline" onClick={() => openUrlSync(TERMS_OF_USE_URL)}>
            Terms of Use
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => openUrlSync(PRIVACY_POLICY_URL)}
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
