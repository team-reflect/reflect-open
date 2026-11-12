import { useState, type ReactElement } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import {
  IAP_PRODUCT_IDS,
  PAYWALL_HIDDEN_DAYS,
  PAYWALL_SKIPPABLE_DAYS,
  formatFullDate,
  getPaywallDaysLeft,
  getPaywallRequiredAt,
  type PaywallPhase,
} from '@reflect/core'
import appIcon from '@/assets/app-icon.png'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { mutationKeys, mutationScopeIds, queryKeys } from '@/lib/query-client.ts'
import { useStore } from '@/lib/use-store.ts'
import { cn } from '@/lib/utils.ts'
import { ClassicMemberDrawer } from '@/mobile/classic-member-drawer.tsx'
import { ClassicSignInProgress } from '@/mobile/classic-sign-in-progress.tsx'
import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '@/mobile/legal-urls.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/mobile/scroll-drawer.tsx'
import {
  classicAccessMessage,
  useClassicAccess,
  useClassicSignIn,
} from '@/mobile/use-classic-access.ts'
import { useIapRestoreRedeem } from '@/mobile/use-iap-restore-redeem.ts'
import { useDateFormat } from '@/providers/settings-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

type PurchasePlan = 'monthly' | 'yearly'

type PaywallMode = Exclude<PaywallPhase, 'hidden'>

interface PurchaseVariables {
  plan: PurchasePlan
  productId: string
}

/** V1 web page that hands a paying Reflect member their free-year offer code. */
const CLAIM_FREE_YEAR_URL = 'https://reflect.app/claim-reflect-open'

const FREE_DAYS = PAYWALL_HIDDEN_DAYS + PAYWALL_SKIPPABLE_DAYS

interface PaywallDrawerProps {
  gate: PaywallPhase
  /**
   * Called when the skippable paywall is swiped away or the user taps Later.
   */
  onDismiss: () => void
}

/**
 * The paywall as a near full-screen drawer. Closing a skippable paywall calls
 * `onDismiss`. A required one ignores every request to close: a tap above the
 * sheet and Escape do nothing, and a swipe scrolls the sheet back open.
 */
export function PaywallDrawer({ gate, onDismiss }: PaywallDrawerProps): ReactElement {
  // The last open mode, so the exit animation keeps its content.
  const [mode, setMode] = useState<PaywallMode>(gate === 'skippable' ? 'skippable' : 'required')
  if (gate !== 'hidden' && gate !== mode) {
    setMode(gate)
  }
  return (
    <Drawer
      open={gate !== 'hidden'}
      onOpenChange={(open) => {
        if (!open && mode === 'skippable') onDismiss()
      }}
    >
      <DrawerContent>
        <PaywallContent mode={mode} onLater={onDismiss} />
      </DrawerContent>
    </Drawer>
  )
}

function PaywallContent({
  mode,
  onLater,
}: {
  mode: PaywallMode
  onLater: () => void
}): ReactElement {
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
    <DrawerBody className="gap-6 px-5 pt-2">
      {mode === 'skippable' ? <SkippableHeader onLater={onLater} /> : <RequiredHeader />}

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
              Subscribe
            </Button>
            <p className="text-center text-xs leading-5 text-text-muted">
              Renews automatically until canceled. Cancel anytime in the App Store.
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

      <footer className="flex justify-center gap-4 text-[13px] text-text-muted">
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
    </DrawerBody>
  )
}

function AppIcon(): ReactElement {
  return <img src={appIcon} alt="" draggable={false} className="size-11 shrink-0 rounded-xl" />
}

const TITLE_CLASS = 'px-0 pt-0 text-2xl leading-tight font-semibold tracking-tight'

function SkippableHeader({ onLater }: { onLater: () => void }): ReactElement {
  const { installClock } = useMobileServices()
  const { clock } = useCoreServices()
  const dateFormat = useDateFormat()
  const { firstLaunchAt } = useStore(installClock)
  // 0 when the first launch is unknown, or when Debug simulates the skippable
  // phase on an older install. Both leave out the countdown.
  const daysLeft = firstLaunchAt === null ? 0 : getPaywallDaysLeft(firstLaunchAt, clock.now())

  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        {daysLeft === 0 ? (
          <span />
        ) : (
          <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
            {daysLeft === 1 ? '1 free day left' : `${daysLeft} free days left`}
          </span>
        )}
        <button type="button" className="text-base font-medium text-primary" onClick={onLater}>
          Later
        </button>
      </div>
      <div className="flex items-center gap-4">
        <AppIcon />
        <DrawerTitle className={TITLE_CLASS}>Enjoying Reflect?</DrawerTitle>
      </div>
      <p className="text-sm leading-6 text-text-secondary">
        Subscribe to keep your notes, tasks, search, and AI on iPhone and iPad.
      </p>
      {firstLaunchAt !== null && daysLeft > 0 ? (
        <div className="flex flex-col gap-2">
          <div
            role="progressbar"
            aria-label="Free days used"
            aria-valuemin={0}
            aria-valuemax={FREE_DAYS}
            aria-valuenow={FREE_DAYS - daysLeft}
            className="h-1.5 overflow-hidden rounded-full bg-border"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${((FREE_DAYS - daysLeft) / FREE_DAYS) * 100}%` }}
            />
          </div>
          <div className="flex justify-between gap-4 text-xs text-text-muted">
            <span>
              Day {Math.min(FREE_DAYS, FREE_DAYS - daysLeft + 1)} of {FREE_DAYS}
            </span>
            <span>
              Free until {formatFullDate(new Date(getPaywallRequiredAt(firstLaunchAt)), dateFormat)}
            </span>
          </div>
        </div>
      ) : null}
    </header>
  )
}

const REASSURANCES = [
  {
    title: 'Cancel in two taps.',
    detail: 'Any time in Settings › Apple ID › Subscriptions.',
  },
  {
    title: 'Your notes stay yours.',
    detail: 'They are Markdown files you can open in Files, subscribed or not.',
  },
  {
    title: 'Private by default.',
    detail: 'Notes stay on your devices. Sync with iCloud or your own Git server.',
  },
]

function RequiredHeader(): ReactElement {
  return (
    <header className="flex flex-col gap-4 pt-4">
      <div className="flex items-center gap-4">
        <AppIcon />
        <DrawerTitle className={TITLE_CLASS}>Unlock Reflect Pro</DrawerTitle>
      </div>
      <p className="text-sm leading-6 text-text-secondary">
        Your free period has ended. Subscribe to keep using Reflect on iPhone and iPad.
      </p>
      <ul className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
        {REASSURANCES.map((item) => (
          <li key={item.title} className="flex items-start gap-3 text-sm leading-5">
            <span
              aria-hidden
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <Check className="size-3" strokeWidth={3} />
            </span>
            <span className="flex flex-col">
              <span className="font-medium">{item.title}</span>
              <span className="text-text-secondary">{item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </header>
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
