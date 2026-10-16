import { mobileSyncStatus, type MobileSyncStatus } from '@reflect/app'
import { useBackupCountdown } from '@/components/backup-countdown.tsx'
import { useSyncContext } from '@/providers/sync-provider.tsx'

/**
 * {@link MobileSyncStatus} with its detail as text, the waiting countdown
 * included.
 */
export interface MobileSyncStatusView extends Omit<MobileSyncStatus, 'detail'> {
  detail: string | null
}

/**
 * The mobile sync status, ready to display. `null` when there is nothing
 * truthful to say: no backup configured, or no sync lifecycle mounted (dev
 * harness, tests). The derivation lives in app's `mobileSyncStatus`.
 *
 * One hook for both surfaces (settings sheet, status pill) so they can never
 * disagree.
 */
export function useMobileSyncStatus(): MobileSyncStatusView | null {
  const sync = useSyncContext()
  const status = mobileSyncStatus({ backup: sync?.backup ?? null })
  const countdown = useBackupCountdown(
    status?.detail?.kind === 'countdown' ? status.detail.until : null,
  )

  if (status === null) {
    return null
  }
  const detail = status.detail
  return {
    label: status.label,
    tone: status.tone,
    detail:
      detail === null
        ? null
        : detail.kind === 'message'
          ? detail.text
          : countdown === null
            ? null
            : `Backs up in ${countdown}`,
  }
}
