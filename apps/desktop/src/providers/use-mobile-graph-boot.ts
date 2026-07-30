import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  createGraph,
  errorMessage,
  isMobilePlatform,
  loadSettings,
  mobileStorage,
  mobileStorageLocal,
  type AppPlatform,
  type MobileStorageInfo,
  type MobileStorageKind,
} from '@reflect/core'
import { takeWarmMobileStorage } from '@/lib/mobile-boot-warm'
import { SETTINGS_QUERY_KEY, useSettings } from '@/providers/settings-provider'

/** The graph directory created in the container for a fresh start — reads as
 * `iCloud Drive → Reflect → Notes` in Files/Finder. */
const DEFAULT_ICLOUD_GRAPH_NAME = 'Notes'

/**
 * Backoff for the onboarding-time container resolve. A failed lookup is
 * usually transient (network, first-run provisioning) — giving up on the
 * first error would flip the onboarding iCloud card to its signed-out copy
 * even though iCloud is fine. Only after these retries drain does the card
 * degrade to the (still actionable) signed-out state.
 */
const ONBOARDING_RESOLVE_RETRY_DELAYS_MS = [2_000, 8_000]

/** `/…/Documents/My Notes` → `My Notes`. */
function graphNameFromRoot(root: string): string {
  return root.split('/').filter(Boolean).at(-1) ?? ''
}

/**
 * The absolute root for a mobile storage kind, or null when that root is
 * unavailable (an `'icloud'` kind with iCloud signed out / off). The one
 * mapping from the persisted selectors — the *kind* plus, for iCloud, the
 * graph *name* — to a launch-derived path. The container can hold several
 * graphs: prefer the persisted name, fall back to the first existing graph
 * (a rename on another device must not strand the phone), and only a truly
 * empty container yields a fresh directory to create.
 */
function storageRoot(
  info: MobileStorageInfo,
  kind: MobileStorageKind,
  graphName: string,
): string | null {
  if (kind === 'local') {
    return info.localRoot
  }
  if (info.icloudDocumentsRoot === null) {
    return null
  }
  const byName = info.icloudGraphRoots.find((root) => graphNameFromRoot(root) === graphName)
  return (
    byName ??
    info.icloudGraphRoots[0] ??
    `${info.icloudDocumentsRoot}/${graphName === '' ? DEFAULT_ICLOUD_GRAPH_NAME : graphName}`
  )
}

export interface MobileGraphBootOptions {
  platform: AppPlatform
  /** The provider's serialized open; resolves true on a confirmed 'ready'. */
  openRecent: (root: string) => Promise<boolean>
  /**
   * Park the provider on its 'choosing' state — onboarding when
   * {@link MobileGraphBoot.needsOnboarding} is up, the open-failed screen
   * when an `error` message rides along. Must be referentially stable.
   */
  onParked: (error: string | null) => void
}

/** The mobile-only slice of the graph context this hook owns. */
export interface MobileGraphBoot {
  /**
   * The user hasn't yet chosen where their notes live (Plan 19, step 6), so
   * both fixed roots are left untouched and the onboarding screen shows
   * instead of the graph. Always false on desktop.
   */
  needsOnboarding: boolean
  /**
   * The storage roots available to the graph (Plan 21), derived fresh at
   * bootstrap (null elsewhere). Paths must never be persisted — iOS
   * container paths change across restore/update. On a fresh install this is
   * seeded with the sandbox root alone (available instantly) while the
   * iCloud container resolves — see {@link mobileStorageResolving}.
   */
  mobileStorageInfo: MobileStorageInfo | null
  /**
   * True while the iCloud container is still resolving (the first
   * `URLForUbiquityContainerIdentifier` call on a fresh install can take a
   * long time). Onboarding shows the iCloud section as pending rather than
   * hiding it — a null `icloudDocumentsRoot` alone would read as "signed
   * out".
   */
  mobileStorageResolving: boolean
  /**
   * Which root the open graph lives in — `'icloud'` for the iCloud Drive
   * container, `'local'` for the app sandbox. Null until a graph is open
   * (and always null on desktop). The iCloud foreground refresh keys off
   * this.
   */
  mobileStorageKind: MobileStorageKind | null
  /**
   * Open a storage choice and persist it (onboarded flag, storage kind, and
   * — for iCloud — the graph *name*, since the container can hold several
   * graphs). Used by onboarding to finish, and by the settings graph
   * switcher to move between graphs. `root` selects a specific container
   * graph (or a fresh directory to create); omitted, the kind's default
   * root opens.
   */
  completeOnboarding: (kind: MobileStorageKind, root?: string) => Promise<void>
}

/**
 * The mobile graph bootstrap (Plans 19/21), extracted from `GraphProvider`:
 * no chooser and no recents-driven reopen — the graph lives in one of two
 * fixed roots (the app's iCloud Drive container, or the app sandbox
 * `Documents/`) and only the *kind* is persisted, with absolute paths
 * derived fresh every launch.
 *
 * Boot order is deliberate: the settings read is shared with the app-wide
 * provider's query (started before this chunk even loaded) and the container
 * resolve runs in parallel with it, so nothing on this path waits on work
 * that already happened or could overlap — resolving the container can take
 * a long time on a fresh install.
 * A fresh install shows onboarding immediately (sandbox root seeded
 * instantly, iCloud section pending); an onboarded local graph opens
 * without touching the container at all. Inert on desktop.
 */
export function useMobileGraphBoot(options: MobileGraphBootOptions): MobileGraphBoot {
  const { platform, openRecent, onParked } = options
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [mobileStorageInfo, setMobileStorageInfo] = useState<MobileStorageInfo | null>(null)
  const [mobileStorageResolving, setMobileStorageResolving] = useState(false)
  const [mobileStorageKind, setMobileStorageKind] = useState<MobileStorageKind | null>(null)
  // Settings live in one place (the app-wide provider): write the onboarded
  // flag through it so its cached document carries the flag too — a raw save
  // would be clobbered by the next change.
  const { updateSettings, whenSettingsLoaded } = useSettings()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!isMobilePlatform(platform)) {
      return
    }
    let active = true
    // The container resolve is the slow IPC on this path and depends on
    // nothing below — adopt the warm started at platform resolve (see
    // mobile-boot-warm.ts) or start one now, so it overlaps the settings
    // read instead of running after it. Every consumer below attaches its
    // own handlers; this catch only silences the paths that never do.
    const storagePromise = takeWarmMobileStorage() ?? mobileStorage()
    storagePromise.catch(() => {})
    /** Fill the storage info once the container resolves — background only.
     * The early-started promise can hit a transient failure the old
     * call-at-this-point wouldn't have; one fresh retry covers that. */
    const resolveStorageInBackground = (): void => {
      void storagePromise
        .catch(() => mobileStorage())
        .then(
          (storage) => {
            if (active) {
              setMobileStorageInfo(storage)
            }
          },
          (err) => {
            console.error('mobile storage resolution failed:', errorMessage(err))
          },
        )
    }
    void (async () => {
      try {
        // The settings provider started this exact query at first render —
        // before the mobile chunk was even fetched — so this reads the
        // in-flight (usually settled) load instead of issuing a second
        // settings_load round trip.
        const settings = await queryClient.ensureQueryData({
          queryKey: SETTINGS_QUERY_KEY,
          queryFn: loadSettings,
        })
        if (!active) {
          return
        }
        // Gate the first launch on the onboarding choice (Plan 19, step 6).
        // A missing/false flag is a fresh install: defer the open until the
        // user chooses (opening here would bootstrap and seed a root they
        // may not want). Once onboarded, open the persisted storage kind.
        if (settings.mobileOnboarded !== true) {
          // Show onboarding immediately. The sandbox root resolves in
          // milliseconds and unlocks the on-device choice; the iCloud
          // section renders as pending until the container resolves.
          setNeedsOnboarding(true)
          onParked(null)
          setMobileStorageResolving(true)
          void mobileStorageLocal().then(
            (localRoot) => {
              if (active) {
                setMobileStorageInfo(
                  (prev) => prev ?? { localRoot, icloudDocumentsRoot: null, icloudGraphRoots: [] },
                )
              }
            },
            () => {
              // Non-fatal: the full resolve below carries the local root too.
            },
          )
          const resolveWithRetries = (
            attempt: number,
            pending: Promise<MobileStorageInfo>,
          ): void => {
            void pending.then(
              (storage) => {
                if (active) {
                  setMobileStorageInfo(storage)
                  setMobileStorageResolving(false)
                }
              },
              (err) => {
                console.error('mobile storage resolution failed:', errorMessage(err))
                if (!active) {
                  return
                }
                const delay = ONBOARDING_RESOLVE_RETRY_DELAYS_MS[attempt]
                if (delay === undefined) {
                  setMobileStorageResolving(false)
                  return
                }
                setTimeout(() => {
                  if (active) {
                    resolveWithRetries(attempt + 1, mobileStorage())
                  }
                }, delay)
              },
            )
          }
          resolveWithRetries(0, storagePromise)
          return
        }
        const kind = settings.mobileStorage
        if (kind === 'local') {
          // The sandbox graph needs no container: open it right away and
          // let the full storage info (the settings switcher reads it)
          // resolve in the background.
          const localRoot = await mobileStorageLocal()
          if (!active) {
            return
          }
          resolveStorageInBackground()
          setMobileStorageKind('local')
          await openRecent(localRoot)
          return
        }
        // The early-started resolve, with one fresh retry on failure — a
        // transient error from the head-start call must not park a graph the
        // call-at-this-point would have opened.
        const storage = await storagePromise.catch(() => mobileStorage())
        if (!active) {
          return
        }
        setMobileStorageInfo(storage)
        const root = storageRoot(storage, kind, settings.mobileGraphName)
        if (root === null) {
          // The graph lives in iCloud but the account is gone (signed out,
          // iCloud Drive off). Opening the empty local root instead would
          // silently start a second graph — park on an honest error until
          // iCloud is back.
          onParked(
            'Your notes are stored in iCloud Drive, but iCloud isn’t available on this device. Sign in to iCloud in Settings, then reopen Reflect.',
          )
          return
        }
        setMobileStorageKind(kind)
        await openRecent(root)
      } catch (err) {
        if (active) {
          onParked(errorMessage(err))
        }
      }
    })()
    return () => {
      active = false
    }
  }, [platform, openRecent, onParked, queryClient])

  const completeOnboarding = useCallback(
    async (kind: MobileStorageKind, chosenRoot?: string): Promise<void> => {
      // An explicit root comes from the onboarding graph list or the settings
      // switcher (open THIS container graph / create one with this name);
      // without one, fall back to the kind's default root — the local path
      // never passes a root.
      const root =
        chosenRoot ?? (mobileStorageInfo === null ? null : storageRoot(mobileStorageInfo, kind, ''))
      if (root === null) {
        throw new Error(
          kind === 'icloud'
            ? 'iCloud Drive isn’t available on this device.'
            : 'No graph folder available.',
        )
      }
      const shouldCreateIcloudRoot =
        kind === 'icloud' && mobileStorageInfo?.icloudGraphRoots.includes(root) !== true
      if (shouldCreateIcloudRoot) {
        await createGraph(root)
      }
      // Keep the onboarding gate up while the open runs — `openRecent` moves the
      // status to 'opening' synchronously and the onboarding screen shows its own
      // pending state, so the shell never flashes. On failure throw rather than
      // clear the gate: the screen surfaces the error and stays on onboarding for
      // an in-app retry (re-choosing re-opens an already-populated root) instead
      // of landing on the dead-end open-failed screen.
      const opened = await openRecent(root)
      if (!opened) {
        throw new Error('Couldn’t open your notes — please try again.')
      }
      setMobileStorageKind(kind)
      setNeedsOnboarding(false)
      // Persist the flags only once the graph is actually open, so a failed open
      // never strands the user past onboarding. Write through the settings
      // provider (not a raw save), awaiting hydration first — the provider's
      // contract for a setting paired with a keychain secret: after a failed
      // load it stays session-only and the next launch re-onboards, where
      // re-choosing re-opens the existing graph (no data loss).
      await whenSettingsLoaded()
      updateSettings({
        mobileOnboarded: true,
        mobileStorage: kind,
        // The container can hold several graphs — remember WHICH one by name
        // (never by path; container paths change across restore/update).
        mobileGraphName: kind === 'icloud' ? graphNameFromRoot(root) : '',
      })
    },
    [mobileStorageInfo, openRecent, updateSettings, whenSettingsLoaded],
  )

  return {
    needsOnboarding,
    mobileStorageInfo,
    mobileStorageResolving,
    mobileStorageKind,
    completeOnboarding,
  }
}
