import { minutesUntil, type BackupState } from '@reflect/core'

/**
 * The plain-language sync status mobile shows (Plan 19, step 10). The phone
 * spends much of its life "not yet pushed" — foreground-only cycles — so the
 * status surface matters more than on desktop, and it must never speak git:
 * no commits, branches, or merges, just what the user's notes are doing.
 */
export interface MobileSyncStatus {
  /**
   * What the user reads: `Backed up`, `Syncing`, `Needs review`, …
   */
  label: string
  /**
   * Drives the indicator color: calm, working, or wants a look. `ok` is the
   * all-good resting state — the settings sheet still shows its label, but
   * the floating pill hides (quiet UI — no chrome when nothing's wrong).
   */
  tone: 'ok' | 'active' | 'attention'
  /**
   * A plain-language line with more detail (offline/error states), if any.
   */
  detail: string | null
}

/**
 * Map the engine's product state (plus the graph's conflicted-note count,
 * which outlives any one cycle) to the mobile wording. `null` when the graph
 * has no backup configured — there is no status to speak of.
 *
 * Precedence: an in-flight cycle shows as `Syncing` (it may be resolving the
 * rest); conflicted notes then take the headline (`Needs review` persists
 * across idle cycles — conflicts never block other notes from syncing, so
 * the engine alone would happily report all-clear); errors and offline last.
 */
function statusForBackup(
  backup: BackupState,
  conflictCount: number,
  now: number,
): MobileSyncStatus | null {
  if (backup.phase !== 'connected') {
    return null
  }
  const status = backup.status
  if (status.state === 'syncing') {
    return { label: 'Syncing', tone: 'active', detail: null }
  }
  if (conflictCount > 0) {
    return {
      label: 'Needs review',
      tone: 'attention',
      detail:
        conflictCount === 1
          ? 'A note was edited on two devices at once — open it to choose what to keep.'
          : `${conflictCount} notes were edited on two devices at once — open them to choose what to keep.`,
    }
  }
  if (status.state === 'error') {
    return { label: 'Needs attention', tone: 'attention', detail: status.message }
  }
  if (status.state === 'offline') {
    return { label: 'Offline', tone: 'attention', detail: status.message }
  }
  if (status.state === 'waiting') {
    return {
      label: 'Backed up',
      tone: 'ok',
      detail: `Backs up in ${minutesUntil(status.until, now)} min`,
    }
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
  /**
   * The graph's conflicted-note count; `undefined` until it is known.
   */
  conflictCount: number | undefined
  /**
   * Whether reading the conflicted-note count failed.
   */
  conflictCountUnavailable: boolean
  /**
   * The current time, epoch ms.
   */
  now: number
}

/**
 * The mobile sync status, ready to display — engine state joined with the
 * graph's conflicted-note count (which outlives any one cycle). `null` when
 * there is nothing truthful to say: no backup configured, no sync lifecycle
 * mounted (dev harness, tests), or the conflict count still loading — a
 * status shown before the count is known could claim `Backed up` over
 * conflict markers already on disk, then flip.
 */
export function mobileSyncStatus({
  backup,
  conflictCount,
  conflictCountUnavailable,
  now,
}: SyncStatusInput): MobileSyncStatus | null {
  const connected = backup !== null && backup.phase === 'connected'
  // Loading hides the status (no flip); a *failed* count must not — the
  // engine-driven states (Syncing, Offline, Needs attention) don't depend on
  // it, and blanking them over an unreadable index would hide real signal.
  // The degradation is losing the Needs-review headline until the index
  // recovers.
  if (backup === null || (connected && conflictCount === undefined && !conflictCountUnavailable)) {
    return null
  }
  return statusForBackup(backup, conflictCount ?? 0, now)
}
