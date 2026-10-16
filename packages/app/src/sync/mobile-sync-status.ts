import type { BackupState } from '@reflect/core'

/**
 * The plain-language sync status mobile shows (Plan 19, step 10). The phone
 * spends much of its life "not yet pushed" — foreground-only cycles — so the
 * status surface matters more than on desktop, and it must never speak git:
 * no commits, branches, or merges, just what the user's notes are doing.
 */
export interface MobileSyncStatus {
  /**
   * What the user reads: `Backed up`, `Syncing`, `Offline`, …
   */
  label: string
  /**
   * Drives the indicator color: calm, working, or wants a look. `ok` is the
   * all-good resting state — the settings sheet still shows its label, but
   * the floating pill hides (quiet UI — no chrome when nothing's wrong).
   */
  tone: 'ok' | 'active' | 'attention'
  /**
   * More detail, if any: a plain-language line (offline and error states), or
   * the time the next backup is due (waiting state), which the surface counts
   * down itself.
   */
  detail: MobileSyncDetail | null
}

/**
 * The detail of a {@link MobileSyncStatus}.
 */
export type MobileSyncDetail =
  | { kind: 'message'; text: string }
  | { kind: 'countdown'; until: number }

/**
 * Map the engine's product state to the mobile wording. `null` when the graph
 * has no backup configured — there is no status to speak of.
 *
 * Precedence: an in-flight cycle shows as `Syncing`; errors and offline last.
 */
function statusForBackup(backup: BackupState): MobileSyncStatus | null {
  if (backup.phase !== 'connected') {
    return null
  }
  const status = backup.status
  if (status.state === 'syncing') {
    return { label: 'Syncing', tone: 'active', detail: null }
  }
  if (status.state === 'error') {
    return {
      label: 'Needs attention',
      tone: 'attention',
      detail: { kind: 'message', text: status.message },
    }
  }
  if (status.state === 'offline') {
    return {
      label: 'Offline',
      tone: 'attention',
      detail: { kind: 'message', text: status.message },
    }
  }
  if (status.state === 'waiting') {
    return { label: 'Backed up', tone: 'ok', detail: { kind: 'countdown', until: status.until } }
  }
  return { label: 'Backed up', tone: 'ok', detail: null }
}

/**
 * What {@link mobileSyncStatus} derives the status from.
 */
export interface SyncStatusInput {
  /**
   * The open graph's backup state; `null` when no backup lifecycle is mounted.
   */
  backup: BackupState | null
}

/**
 * The mobile sync status, ready to display. `null` when there is nothing
 * truthful to say: no backup configured, or no sync lifecycle mounted (dev
 * harness, tests).
 */
export function mobileSyncStatus({ backup }: SyncStatusInput): MobileSyncStatus | null {
  if (backup === null) {
    return null
  }
  return statusForBackup(backup) // FIXME: 1 merge statusForBackup and mobileSyncStatus into one function. // FIXME 2: rename mobileSyncStatus to something more descriptive, like getMobileSyncStatus.
}
