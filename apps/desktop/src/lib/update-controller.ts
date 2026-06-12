import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

/**
 * The auto-update lifecycle (Plan 15), as plain-language phases the UI renders
 * directly: nothing → "Update available" → "Downloading…" → "Restart to
 * update". Every transition is user-deferrable — the app never blocks on an
 * update, and a failed check leaves the app exactly as it was.
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'upToDate' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number | null }
  | { phase: 'ready'; version: string }
  /** `during` tells surfaces what failed: a check retries by re-checking, a
      failed install still has its found update and retries by installing. */
  | { phase: 'error'; message: string; during: 'check' | 'install' }

export interface UpdateController {
  getState: () => UpdateState
  subscribe: (listener: () => void) => () => void
  /** Begin auto-checking (when enabled): once now, then on an interval. */
  start: () => void
  /** User-initiated check — surfaces "up to date" and failures, unlike auto. */
  checkNow: () => Promise<void>
  /** Download + install the found update; progress lands in the state. */
  install: () => Promise<void>
  /** Relaunch into the installed update. */
  restart: () => Promise<void>
  dispose: () => void
}

export interface UpdateControllerOptions {
  /** Check on start and every {@link autoCheckIntervalMs} when true. */
  autoCheck: boolean
  autoCheckIntervalMs?: number
}

/** Six hours — frequent enough to catch releases, quiet enough to be free. */
const DEFAULT_AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Drives `@tauri-apps/plugin-updater` as a subscribable state machine. The
 * plugin verifies every downloaded payload against the minisign pubkey in
 * `tauri.conf.json` before installing — a tampered or unsigned artifact
 * surfaces here as a plain `error` state, never as an install.
 *
 * Auto-checks fail silently by design: offline is a normal condition, and the
 * release-endpoint being unreachable must never cost the user attention.
 */
export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const intervalMs = options.autoCheckIntervalMs ?? DEFAULT_AUTO_CHECK_INTERVAL_MS
  const listeners = new Set<() => void>()
  let state: UpdateState = { phase: 'idle' }
  let pendingUpdate: Update | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  function setState(next: UpdateState): void {
    state = next
    for (const listener of listeners) {
      listener()
    }
  }

  // Read through a call so post-await guards see the live phase — TypeScript
  // would otherwise keep the pre-await narrowing of the closed-over `state`.
  function currentPhase(): UpdateState['phase'] {
    return state.phase
  }

  async function runCheck(silent: boolean): Promise<void> {
    if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready') {
      return
    }
    const before = state
    setState({ phase: 'checking' })
    try {
      const update = await check()
      if (currentPhase() !== 'checking') {
        return // an install of the previously-found update raced us; its state wins
      }
      if (update) {
        pendingUpdate = update
        setState({ phase: 'available', version: update.version })
      } else if (!silent) {
        // The user asked: the endpoint's answer is authoritative.
        pendingUpdate = null
        setState({ phase: 'upToDate' })
      } else if (before.phase === 'available') {
        // A silent check only ever adds information — it never retracts a
        // visible affordance. An empty answer can be transient (release being
        // edited, manifest propagation); if the update truly vanished, the
        // install fails loudly, which is the honest signal.
        setState(before)
      } else {
        pendingUpdate = null
        setState({ phase: 'idle' })
      }
    } catch (error) {
      if (currentPhase() !== 'checking') {
        return
      }
      if (silent) {
        console.warn('update check failed (ignored):', error)
        // Same rule as above: failing to re-check (e.g. offline) must not
        // forget an update an earlier check already found.
        setState(before.phase === 'available' ? before : { phase: 'idle' })
      } else {
        setState({ phase: 'error', message: errorMessage(error), during: 'check' })
      }
    }
  }

  async function install(): Promise<void> {
    const update = pendingUpdate
    if (!update || state.phase === 'downloading' || state.phase === 'ready') {
      return
    }
    let contentLength: number | null = null
    let received = 0
    setState({ phase: 'downloading', version: update.version, percent: null })
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? null
            received = 0
            break
          case 'Progress':
            received += event.data.chunkLength
            if (contentLength !== null && contentLength > 0) {
              const percent = Math.min(100, Math.round((received / contentLength) * 100))
              setState({ phase: 'downloading', version: update.version, percent })
            }
            break
          case 'Finished':
            setState({ phase: 'downloading', version: update.version, percent: 100 })
            break
        }
      })
      setState({ phase: 'ready', version: update.version })
    } catch (error) {
      setState({ phase: 'error', message: errorMessage(error), during: 'install' })
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: () => {
      if (!options.autoCheck || timer !== null) {
        return
      }
      void runCheck(true)
      timer = setInterval(() => void runCheck(true), intervalMs)
    },
    checkNow: () => runCheck(false),
    install,
    restart: () => relaunch(),
    dispose: () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
    },
  }
}
