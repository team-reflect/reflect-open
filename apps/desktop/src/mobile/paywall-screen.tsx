import { useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Check } from 'lucide-react'
import {
  IAP_PRODUCT_IDS,
  iapGetProducts,
  iapPurchase,
  iapRestorePurchases,
  type IapProduct,
} from '@reflect/core'
import appIcon from '@/assets/app-icon.png'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '@/mobile/legal-urls'
import { ENTITLEMENT_QUERY_KEY } from '@/mobile/use-entitlement'

/** Which control kicked off the in-flight action (onboarding's PendingChoice
 * pattern): every button disables, only the initiator shows progress. */
type PendingAction = 'monthly' | 'yearly' | 'restore' | null

export function PaywallScreen(): ReactElement {
  const queryClient = useQueryClient()
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
  const savings = yearly !== null && monthly !== null ? yearlySavingsPercent(monthly, yearly) : null
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
      // No navigation on success: the purchaseUpdated event refetches the
      // entitlement and the gate in mobile-app.tsx unmounts this screen.
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
        await queryClient.invalidateQueries({ queryKey: ENTITLEMENT_QUERY_KEY })
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
                badge={savings !== null ? `Save ${savings}%` : 'Best value'}
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
                7 days free, then {selectedPrice}. Cancel anytime in the App Store.
              </p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col items-center gap-2">
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

function PlanCard({
  title,
  price,
  badge,
  selected,
  disabled,
  onSelect,
}: {
  title: string
  price: string
  badge?: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): ReactElement {
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

/**
 * Approximate percent saved by paying yearly instead of twelve monthly
 * renewals. StoreKit only hands us localized display strings, so this parses
 * the digits back out of them; returns null (render no badge) whenever the
 * strings do not parse into two believable prices.
 */
function yearlySavingsPercent(monthly: IapProduct, yearly: IapProduct): number | null {
  const monthlyPrice = parsePrice(monthly.formattedPrice)
  const yearlyPrice = parsePrice(yearly.formattedPrice)
  if (monthlyPrice === null || yearlyPrice === null || monthlyPrice <= 0 || yearlyPrice <= 0) {
    return null
  }
  const fullYear = monthlyPrice * 12
  if (yearlyPrice >= fullYear) return null
  const percent = Math.round(((fullYear - yearlyPrice) / fullYear) * 100)
  return percent >= 5 ? percent : null
}

function parsePrice(formatted: string | null | undefined): number | null {
  if (formatted == null) return null
  const digits = formatted.replaceAll(/[^0-9.,]/g, '')
  if (digits.length === 0) return null
  // The last "." or "," is the decimal separator only when 1-2 digits follow
  // it; a 3-digit tail is read as a thousands group ("1,280"), which is right
  // for every App Store currency except the rare 3-decimal ones, and those
  // only cost us the badge.
  const separator = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','))
  let integer = digits
  let fraction = ''
  if (separator !== -1) {
    const tail = digits.slice(separator + 1)
    if (tail.length > 0 && tail.length <= 2) {
      integer = digits.slice(0, separator)
      fraction = tail
    }
  }
  integer = integer.replaceAll(/[.,]/g, '')
  if (integer.length === 0 && fraction.length === 0) return null
  const value = Number.parseFloat(
    `${integer.length === 0 ? '0' : integer}.${fraction.length === 0 ? '0' : fraction}`,
  )
  return Number.isFinite(value) ? value : null
}
