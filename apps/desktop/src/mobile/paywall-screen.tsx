import { useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { openUrl } from '@tauri-apps/plugin-opener'
import { NotebookPen } from 'lucide-react'
import { IAP_PRODUCT_IDS, iapGetProducts, iapPurchase, iapRestorePurchases } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { PRIVACY_POLICY_URL } from '@/mobile/ai-provider-consent'
import { ENTITLEMENT_QUERY_KEY } from '@/mobile/use-entitlement'

export const TERMS_OF_USE_URL = 'https://reflect.app/terms'

/** Which control kicked off the in-flight action (onboarding's PendingChoice
 * pattern): every button disables, only the initiator shows progress. */
type PendingAction = 'monthly' | 'yearly' | 'restore' | null

export function PaywallScreen(): ReactElement {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<PendingAction>(null)
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null)

  const products = useQuery({
    queryKey: ['iap-products'],
    queryFn: () => iapGetProducts([IAP_PRODUCT_IDS.yearly, IAP_PRODUCT_IDS.monthly]),
  })
  const yearly = products.data?.find((product) => product.productId === IAP_PRODUCT_IDS.yearly)
  const monthly = products.data?.find((product) => product.productId === IAP_PRODUCT_IDS.monthly)
  const productsFailed =
    products.status === 'error' || (products.status === 'success' && (!yearly || !monthly))

  const subscribe = async (productId: string, action: 'monthly' | 'yearly') => {
    setPending(action)
    try {
      await iapPurchase(productId)
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
      <div className="mx-auto flex w-full max-w-md flex-col gap-7 py-6">
        <header className="flex flex-col gap-4 pt-2">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <NotebookPen aria-hidden className="size-5" strokeWidth={1.75} />
          </div>
          <div className="space-y-2">
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
              Unlock Reflect Pro
            </h1>
            <p className="text-sm leading-6 text-text-secondary">
              Notes, tasks, search, and AI on your iPhone. Every plan starts with a 7-day free
              trial; cancel anytime in the App Store.
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

        {yearly && monthly ? (
          <div className="flex flex-col gap-3">
            <Button
              size="lg"
              disabled={pending !== null}
              onClick={() => void subscribe(yearly.productId, 'yearly')}
            >
              {pending === 'yearly' ? <Spinner className="size-4" /> : null}
              Yearly: 7 days free, then {yearly.formattedPrice ?? ''}/year
            </Button>
            <Button
              size="lg"
              variant="secondary"
              disabled={pending !== null}
              onClick={() => void subscribe(monthly.productId, 'monthly')}
            >
              {pending === 'monthly' ? <Spinner className="size-4" /> : null}
              Monthly: 7 days free, then {monthly.formattedPrice ?? ''}/month
            </Button>
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
