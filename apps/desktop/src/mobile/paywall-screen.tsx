import { useState, type ReactElement } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { IAP_PRODUCT_IDS } from '@reflect/core'
import appIcon from '@/assets/app-icon.png'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { mutationKeys, mutationScopeIds, queryKeys } from '@/lib/query-client.ts'
import { cn } from '@/lib/utils.ts'
import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '@/mobile/legal-urls.ts'
import { ClassicMemberDrawer } from '@/mobile/classic-member-drawer.tsx'
import { ClassicSignInProgress } from '@/mobile/classic-sign-in-progress.tsx'
import {
  classicAccessMessage,
  useClassicAccess,
  useClassicSignIn,
} from '@/mobile/use-classic-access.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { useIapRestoreRedeem } from '@/mobile/use-iap-restore-redeem.ts'
import { useAppServices } from '@/services/services-provider.tsx'

type PurchasePlan = 'monthly' | 'yearly'

interface PurchaseVariables {
  plan: PurchasePlan
  productId: string
}

/** V1 web page that hands a paying Reflect member their free-year offer code. */
const CLAIM_FREE_YEAR_URL = 'https://reflect.app/claim-reflect-open'

export function PaywallScreen(): ReactElement {
  const { paywall } = useMobileServices()
  const { opener } = useAppServices()
  const [selectedPlan, setSelectedPlan] = useState<PurchasePlan>('yearly')
  const [classicDrawerOpen, setClassicDrawerOpen] = useState(false)

  const products = useQuery({
    queryKey: queryKeys.iap.products,
    queryFn: () => paywall.products(),
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
    mutationFn: (variables: PurchaseVariables) => paywall.purchase(variables.productId),
  })
  const iap = useIapRestoreRedeem()
  const { restoreMutation, redeemMutation, restoreFeedback, redeemFeedback } = iap
  const classicAccess = useClassicAccess()
  const classicSignIn = useClassicSignIn()
  const classicMessage = classicAccessMessage(classicAccess)
  const actionPending =
    purchaseMutation.isPending ||
    restoreMutation.isPending ||
    redeemMutation.isPending ||
    classicSignIn.mutation.isPending
  const purchasingPlan = purchaseMutation.isPending
    ? (purchaseMutation.variables?.plan ?? null)
    : null

  const subscribe = () => {
    const product = selectedPlan === 'yearly' ? yearly : monthly
    if (product === null) return
    restoreMutation.reset()
    redeemMutation.reset()
    classicSignIn.mutation.reset()
    purchaseMutation.mutate({ plan: selectedPlan, productId: product.productId })
  }

  const restore = () => {
    purchaseMutation.reset()
    classicSignIn.mutation.reset()
    iap.restore()
  }

  const redeem = () => {
    purchaseMutation.reset()
    classicSignIn.mutation.reset()
    iap.redeem()
  }

  const verifyClassic = () => {
    setClassicDrawerOpen(false)
    purchaseMutation.reset()
    restoreMutation.reset()
    redeemMutation.reset()
    classicSignIn.mutation.mutate(false)
  }

  return (
    <div className="flex min-h-dvh w-screen overflow-auto bg-surface-app px-safe-offset-5 pt-safe-or-6 pb-safe-or-4 text-text">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-6">
        <header className="flex flex-col gap-4 pt-2">
          <img src={appIcon} alt="" draggable={false} className="size-11 rounded-xl" />
          <div className="space-y-2">
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
              Unlock Reflect Pro
            </h1>
            <p className="text-sm leading-6 text-text-secondary">
              Notes, tasks, search, and AI. Everything Reflect does on your Mac, now on your iPhone
              and iPad.
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
            onClick={() => setClassicDrawerOpen(true)}
          >
            {classicSignIn.mutation.isPending
              ? 'Signing in…'
              : 'Already a Reflect member? Get your first year free'}
          </button>
          {classicMessage !== null ? (
            <p className="text-center text-sm text-text-muted">{classicMessage}</p>
          ) : null}
          <button
            type="button"
            className="text-sm text-text-muted underline disabled:opacity-50"
            disabled={actionPending}
            onClick={redeem}
          >
            {redeemMutation.isPending ? 'Opening…' : 'Redeem a code'}
          </button>
          {redeemFeedback !== null ? (
            <p className="text-center text-sm text-text-muted">{redeemFeedback}</p>
          ) : null}
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
          <button
            type="button"
            className="underline"
            onClick={() => opener.openUrlSync(TERMS_OF_USE_URL)}
          >
            Terms of Use
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => opener.openUrlSync(PRIVACY_POLICY_URL)}
          >
            Privacy Policy
          </button>
        </footer>
      </div>
      <ClassicMemberDrawer
        open={classicDrawerOpen}
        onOpenChange={setClassicDrawerOpen}
        onSignIn={verifyClassic}
        onWebClaim={() => {
          setClassicDrawerOpen(false)
          opener.openUrlSync(CLAIM_FREE_YEAR_URL)
        }}
      />
      <ClassicSignInProgress signIn={classicSignIn} />
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
