import {
  DEFAULT_GRAPH_NAME,
  errorMessage,
  graphNameFromRoot,
  isMobilePlatform,
  type ActivityPort,
  type ClockService,
  type GraphSessionService,
  type LoggerService,
  type MobileStorageInfo,
  type MobileStorageKind,
  type MobileStorageService,
  type PlatformFacts,
  type SettingsLoadOutcome,
  type SettingsService,
  type TimerHandle,
  type Unlisten,
} from '@reflect/core'

/**
 * Backoff for the onboarding-time container resolve. A failed lookup is
 * usually transient (network, first-run provisioning) — giving up on the
 * first error would flip the onboarding iCloud card to its signed-out copy
 * even though iCloud is fine. Only after these retries drain does the card
 * degrade to the (still actionable) signed-out state.
 */
const ONBOARDING_RESOLVE_RETRY_DELAYS_MS = [2_000, 8_000]

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
    `${info.icloudDocumentsRoot}/${graphName === '' ? DEFAULT_GRAPH_NAME : graphName}`
  )
}

/**
 * What a {@link MobileOnboardingService} publishes. Replaced, never mutated, on every change.
 */
export interface MobileOnboardingState {
  /**
   * The user hasn't yet chosen where their notes live (Plan 19, step 6), so
   * both fixed roots are left untouched and the onboarding screen shows
   * instead of the graph. Always false on desktop.
   */
  readonly needsOnboarding: boolean
  /**
   * The storage roots available to the graph (Plan 21), derived fresh at
   * bootstrap (null elsewhere). Paths must never be persisted — iOS
   * container paths change across restore/update. On a fresh install this is
   * seeded with the sandbox root alone (available instantly) while the
   * iCloud container resolves — see {@link resolving}.
   */
  readonly storageInfo: MobileStorageInfo | null
  /**
   * True while the iCloud container is still resolving (the first
   * `URLForUbiquityContainerIdentifier` call on a fresh install can take a
   * long time). Onboarding shows the iCloud section as pending rather than
   * hiding it — a null `icloudDocumentsRoot` alone would read as "signed
   * out".
   */
  readonly resolving: boolean
  /**
   * Which root the open graph lives in — `'icloud'` for the iCloud Drive
   * container, `'local'` for the app sandbox. Null until a graph is open
   * (and always null on desktop). The iCloud foreground refresh keys off
   * this.
   */
  readonly kind: MobileStorageKind | null
}

/**
 * The mobile graph bootstrap (Plans 19/21): no chooser and no recents-driven
 * reopen — the graph lives in one of two fixed roots (the app's iCloud Drive
 * container, or the app sandbox `Documents/`) and only the *kind* is
 * persisted, with absolute paths derived fresh every launch. Members are
 * function properties so surfaces can pass them around unbound.
 */
export interface MobileOnboardingService {
  getState: () => MobileOnboardingState
  subscribe: (listener: () => void) => Unlisten
  /**
   * Boot-time head start for the storage resolve (idempotent). Resolving the
   * iCloud container (`URLForUbiquityContainerIdentifier` plus the graph
   * scan) is the slowest IPC on the mobile boot path, and it depends on
   * nothing else — not settings, not React. The next {@link boot} adopts the
   * in-flight resolve.
   *
   * Consume-once by design: the warm slot is a boot hint, not a cache.
   * Storage roots must be derived fresh everywhere else (container paths
   * change across restore/update), so a taken — or never-started — slot just
   * means the boot makes its own fresh call.
   */
  warm(): void
  /**
   * Run the mobile boot path: a fresh install parks on onboarding (sandbox
   * root seeded instantly, iCloud section pending); an onboarded graph opens
   * from its persisted kind and name. When the settings load failed, it
   * reloads them and runs again the next time the app is focused or visible.
   * Inert on desktop. The returned function stops the boot.
   */
  boot(): Unlisten
  /**
   * Open a storage choice and persist it (onboarded flag, storage kind, and
   * — for iCloud — the graph *name*, since the container can hold several
   * graphs). Used by onboarding to finish, and by the settings graph
   * switcher to move between graphs. `root` selects a specific container
   * graph (or a fresh directory to create); omitted, the kind's default
   * root opens.
   */
  completeOnboarding(kind: MobileStorageKind, root?: string): Promise<void>
}

export interface MobileOnboardingServiceDeps {
  readonly mobileStorage: MobileStorageService
  readonly settings: SettingsService
  /**
   * The session's serialized open, and its 'choosing' state for a boot that opens nothing.
   */
  readonly graphSession: GraphSessionService
  readonly platform: PlatformFacts
  readonly clock: ClockService
  readonly activity: ActivityPort
  readonly logger: LoggerService
}

class MobileOnboardingServiceImpl implements MobileOnboardingService {
  readonly #deps: MobileOnboardingServiceDeps
  readonly #listeners = new Set<() => void>()
  #state: MobileOnboardingState = {
    needsOnboarding: false,
    storageInfo: null,
    resolving: false,
    kind: null,
  }
  #warmed: Promise<MobileStorageInfo> | null = null

  constructor(deps: MobileOnboardingServiceDeps) {
    this.#deps = deps
  }

  readonly getState = (): MobileOnboardingState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Rejections are handled by whoever takes the promise; the guard here only
   * silences the unhandled-rejection report when nothing ever does.
   */
  warm(): void {
    if (this.#warmed === null) {
      this.#warmed = this.#deps.mobileStorage.resolve()
      this.#warmed.catch(() => {})
    }
  }

  /**
   * Boot order is deliberate: the settings read is shared with the app-wide
   * settings load (started before the mobile chunk even loaded) and the
   * container resolve runs in parallel with it, so nothing on this path waits
   * on work that already happened or could overlap — resolving the container
   * can take a long time on a fresh install.
   */
  boot(): Unlisten {
    const {
      mobileStorage,
      settings: settingsService,
      graphSession,
      platform,
      clock,
      activity,
      logger,
    } = this.#deps
    if (!isMobilePlatform(platform.appPlatform)) {
      return () => {}
    }
    let active = true
    let retryTimer: TimerHandle | undefined
    let removeSettingsRetry: Unlisten | undefined
    // The container resolve is the slow IPC on this path and depends on
    // nothing below — adopt the warm started at platform resolve or start
    // one now, so it overlaps the settings read instead of running after it.
    // Every consumer below attaches its own handlers; this catch only
    // silences the paths that never do.
    const storagePromise = this.#takeWarm() ?? mobileStorage.resolve()
    storagePromise.catch(() => {})
    // Fill the storage info once the container resolves — background only.
    // The early-started promise can hit a transient failure the old
    // call-at-this-point wouldn't have; one fresh retry covers that.
    const resolveStorageInBackground = (): void => {
      void storagePromise
        .catch(() => mobileStorage.resolve())
        .then(
          (storage) => {
            if (active) {
              this.#setState({ storageInfo: storage })
            }
          },
          (err) => {
            logger.error('mobile storage resolution failed:', errorMessage(err))
          },
        )
    }
    // Reload the settings and run again once the app comes back.
    const retrySettingsOnReturn = (): void => {
      const retry = (): void => {
        removeSettingsRetry?.()
        removeSettingsRetry = undefined
        if (active) {
          run(() => settingsService.reload())
        }
      }
      const removeFocus = activity.subscribeFocus(retry)
      const removeVisible = activity.subscribeVisible(retry)
      removeSettingsRetry = () => {
        removeFocus()
        removeVisible()
      }
    }
    const run = (loadSettings: () => Promise<SettingsLoadOutcome>): void => {
      void (async () => {
        try {
          // The settings load started at first render, before the mobile chunk
          // was even fetched, so this usually reads a settled load.
          if ((await loadSettings()) === 'failed') {
            if (active) {
              graphSession.park('Couldn’t load your settings.')
              retrySettingsOnReturn()
            }
            return
          }
          const settings = settingsService.get()
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
            this.#setState({ needsOnboarding: true })
            graphSession.park(null)
            this.#setState({ resolving: true })
            void mobileStorage.resolveLocal().then(
              (localRoot) => {
                if (active) {
                  this.#setState({
                    storageInfo: this.#state.storageInfo ?? {
                      localRoot,
                      icloudDocumentsRoot: null,
                      icloudGraphRoots: [],
                    },
                  })
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
                    this.#setState({ storageInfo: storage, resolving: false })
                  }
                },
                (err) => {
                  logger.error('mobile storage resolution failed:', errorMessage(err))
                  if (!active) {
                    return
                  }
                  const delay = ONBOARDING_RESOLVE_RETRY_DELAYS_MS[attempt]
                  if (delay === undefined) {
                    this.#setState({ resolving: false })
                    return
                  }
                  retryTimer = clock.setTimeout(() => {
                    if (active) {
                      resolveWithRetries(attempt + 1, mobileStorage.resolve())
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
            const localRoot = await mobileStorage.resolveLocal()
            if (!active) {
              return
            }
            resolveStorageInBackground()
            this.#setState({ kind: 'local' })
            await graphSession.openRecent(localRoot)
            return
          }
          // The early-started resolve, with one fresh retry on failure — a
          // transient error from the head-start call must not park a graph the
          // call-at-this-point would have opened.
          const storage = await storagePromise.catch(() => mobileStorage.resolve())
          if (!active) {
            return
          }
          this.#setState({ storageInfo: storage })
          const root = storageRoot(storage, kind, settings.mobileGraphName)
          if (root === null) {
            // The graph lives in iCloud but the account is gone (signed out,
            // iCloud Drive off). Opening the empty local root instead would
            // silently start a second graph — park on an honest error until
            // iCloud is back.
            graphSession.park(
              'Your notes are stored in iCloud Drive, but iCloud isn’t available on this device. Sign in to iCloud in Settings, then reopen Reflect.',
            )
            return
          }
          this.#setState({ kind })
          await graphSession.openRecent(root)
        } catch (err) {
          if (active) {
            graphSession.park(errorMessage(err))
          }
        }
      })()
    }
    run(() => settingsService.whenLoaded())
    return () => {
      active = false
      removeSettingsRetry?.()
      if (retryTimer !== undefined) {
        clock.clearTimeout(retryTimer)
      }
    }
  }

  async completeOnboarding(kind: MobileStorageKind, chosenRoot?: string): Promise<void> {
    const { mobileStorage, settings: settingsService, graphSession } = this.#deps
    const storageInfo = this.#state.storageInfo
    // An explicit root comes from the onboarding graph list or the settings
    // switcher (open THIS container graph / create one with this name);
    // without one, fall back to the kind's default root — the local path
    // never passes a root.
    const root = chosenRoot ?? (storageInfo === null ? null : storageRoot(storageInfo, kind, ''))
    if (root === null) {
      throw new Error(
        kind === 'icloud'
          ? 'iCloud Drive isn’t available on this device.'
          : 'No graph folder available.',
      )
    }
    const shouldCreateIcloudRoot =
      kind === 'icloud' && storageInfo?.icloudGraphRoots.includes(root) !== true
    if (shouldCreateIcloudRoot) {
      await mobileStorage.createGraph(root)
    }
    // Keep the onboarding gate up while the open runs — `openRecent` moves the
    // status to 'opening' synchronously and the onboarding screen shows its own
    // pending state, so the shell never flashes. On failure throw rather than
    // clear the gate: the screen surfaces the error and stays on onboarding for
    // an in-app retry (re-choosing re-opens an already-populated root) instead
    // of landing on the dead-end open-failed screen.
    const opened = await graphSession.openRecent(root)
    if (!opened) {
      throw new Error('Couldn’t open your notes — please try again.')
    }
    this.#setState({ kind, needsOnboarding: false })
    // Persist the flags only once the graph is actually open, so a failed open
    // never strands the user past onboarding. Await hydration first — the
    // settings contract for a setting paired with a keychain secret: after a
    // failed load it stays session-only and the next launch re-onboards, where
    // re-choosing re-opens the existing graph (no data loss).
    await settingsService.whenLoaded()
    settingsService.update({
      mobileOnboarded: true,
      mobileStorage: kind,
      // The container can hold several graphs — remember WHICH one by name
      // (never by path; container paths change across restore/update).
      mobileGraphName: kind === 'icloud' ? graphNameFromRoot(root) : '',
    })
  }

  #setState(patch: Partial<MobileOnboardingState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /**
   * The in-flight warm resolve, or null when none was started or it was already taken.
   */
  #takeWarm(): Promise<MobileStorageInfo> | null {
    const pending = this.#warmed
    this.#warmed = null
    return pending
  }
}

export function createMobileOnboardingService(
  deps: MobileOnboardingServiceDeps,
): MobileOnboardingService {
  return new MobileOnboardingServiceImpl(deps)
}
