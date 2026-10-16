import { mobileSyncStatus, type MobileSyncStatus } from '@reflect/app'
import { useSyncContext } from '@/providers/sync-provider.tsx'
import { useNow } from '@/hooks/use-now.ts'

/**
 * The mobile sync status, ready to display. `null` when there is nothing
 * truthful to say: no backup configured, or no sync lifecycle mounted (dev
 * harness, tests). The derivation lives in app's `mobileSyncStatus`.
 *
 * One hook for both surfaces (settings sheet, status pill) so they can never
 * disagree.
 */
export function useMobileSyncStatus(): MobileSyncStatus | null {
  const sync = useSyncContext()
  const now = useNow(30_000)
  const backup = sync?.backup ?? null

  return mobileSyncStatus({ backup, now })
}
