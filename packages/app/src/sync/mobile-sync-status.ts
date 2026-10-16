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
 * Map the engine's product state to the mobile wording. `null` when no sync
 * lifecycle is mounted (dev harness, tests) or the graph has no backup
 * configured: there is no status to speak of.
 *
 * Precedence: an in-flight cycle shows as `Syncing`; errors and offline last.
 */
export function getMobileSyncStatus(backup: BackupState | null): MobileSyncStatus | null {
  if (backup === null || backup.phase !== 'connected') {
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
