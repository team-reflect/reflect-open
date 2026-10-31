import type { GitRemote, GitSyncState } from '@reflect/core'

/**
 * The plain-language sync status mobile shows (Plan 19, step 10). The phone
 * spends much of its life "not yet pushed" — foreground-only cycles — so the
 * status surface matters more than on desktop, and it must never speak git:
 * no commits, branches, or merges, just what the user's notes are doing.
 */
export interface MobileSyncStatus {
  /**
   * What the user reads: `Up to date`, `Syncing`, `Offline`, …
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
   * the time the next sync is due (waiting state), which the surface counts
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
 * lifecycle is mounted (dev harness, tests) or the graph has no remote
 * configured: there is no status to speak of. A remote that waits for its
 * sign-in wants a look.
 *
 * Precedence: an in-flight cycle shows as `Syncing`; errors and offline last.
 */
export function getMobileSyncStatus(state: GitSyncState | null): MobileSyncStatus | null {
  if (state === null) {
    return null
  }
  if (state.phase === 'needsCredential') {
    return {
      label: 'Sign-in needed',
      tone: 'attention',
      detail: { kind: 'message', text: signInNeededText(state.remote) },
    }
  }
  if (state.phase !== 'connected') {
    return null
  }
  const status = state.status
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
    return { label: 'Up to date', tone: 'ok', detail: { kind: 'countdown', until: status.until } }
  }
  return { label: 'Up to date', tone: 'ok', detail: null }
}

/**
 * Why the remote waits, and what resumes it. A host sign-in is added in
 * Settings; the GitHub account lives under Accounts; plain http never gets
 * a sign-in, so the fix is the https address.
 */
export function signInNeededText(remote: GitRemote): string {
  if (remote.kind === 'github') {
    return 'Signed out of GitHub. Sign in under Accounts to resume.'
  }
  if (remote.kind === 'https' && remote.origin.startsWith('http:')) {
    return 'Reflect does not send sign-ins over plain http. Use the https address of this repository.'
  }
  const host = remote.kind === 'https' ? new URL(remote.origin).host : 'This host'
  return `${host} needs a username and an access token or password.`
}
