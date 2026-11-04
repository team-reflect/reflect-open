import {
  combineStores,
  deriveStore,
  marketingVersion,
  WritableStore,
  type GraphSessionService,
  type PlatformFacts,
  type StorageService,
  type Store,
  type Unlisten,
} from '@reflect/core'
import type { WindowService } from '../app/window-service.ts'
import type { WhatsNewItem } from './whats-new-content.ts'

/**
 * The full version, prerelease tag included, whose What's New the user last saw or skipped.
 */
export const WHATS_NEW_SEEN_STORAGE_KEY = 'reflect.whats-new.seen'

/**
 * Forces What's New on for QA, for this session only.
 */
export const WHATS_NEW_OVERRIDE_STORAGE_KEY = 'reflect.whats-new.override'

/**
 * How far this launch got: no graph open yet, a graph opened, or a graph
 * opened after the graph chooser or the onboarding (a new install).
 */
export type WhatsNewLaunch = 'opening' | 'opened' | 'openedAfterSetup'

/**
 * Everything {@link decideWhatsNew} reads.
 */
export interface WhatsNewInputs {
  readonly isMainWindow: boolean
  readonly isDev: boolean
  /**
   * The current version's items for this platform.
   */
  readonly items: readonly WhatsNewItem[]
  /**
   * The user already saw or skipped the current version.
   */
  readonly seen: boolean
  readonly override: boolean
  /**
   * Something with priority, like the paywall, shows or may show.
   */
  readonly blocked: boolean
  readonly launch: WhatsNewLaunch
}

/**
 * `wait` shows nothing for now; `skip` shows nothing and marks the version
 * seen; `show` shows the items.
 */
export type WhatsNewDecision = 'wait' | 'skip' | 'show'

/**
 * Whether What's New is hidden or shown.
 */
export type WhatsNewPhase = 'hidden' | 'shown'

/**
 * What to do with What's New for the given inputs.
 */
export function decideWhatsNew(inputs: WhatsNewInputs): WhatsNewDecision {
  if (!inputs.isMainWindow || inputs.launch === 'opening' || inputs.blocked) {
    return 'wait'
  }
  if (inputs.override) {
    return inputs.items.length > 0 ? 'show' : 'wait'
  }
  if (inputs.isDev || inputs.seen) {
    return 'wait'
  }
  if (inputs.launch === 'openedAfterSetup' || inputs.items.length === 0) {
    return 'skip'
  }
  return 'show'
}

function selectIsOverride(value: string | null): boolean {
  return value === 'true'
}

/**
 * The What's New page shown once per app version after an update.
 */
export interface WhatsNewService {
  /**
   * The current version's items for this platform.
   */
  readonly items: readonly WhatsNewItem[]
  /**
   * Whether What's New is hidden or shown.
   */
  readonly phase: Store<WhatsNewPhase>
  /**
   * Whether QA forces What's New on in this session.
   */
  readonly override: Store<boolean>
  setOverride: (next: boolean) => void
  /**
   * Marks the current version as seen and turns the override off.
   */
  dismiss: () => void
  /**
   * Follows how this launch opens its graph, and marks a version seen when it
   * should never show. Call it before the graph boot. Returns the function
   * that stops it.
   */
  start(): Unlisten
}

export interface WhatsNewServiceDeps {
  readonly storage: StorageService
  readonly platform: PlatformFacts
  readonly window: WindowService
  readonly graphSession: GraphSessionService
  /**
   * Whether something with priority, like the paywall, holds What's New back.
   */
  readonly blocked: Store<boolean>
  readonly content: Readonly<Record<string, readonly WhatsNewItem[]>>
}

class WhatsNewServiceImpl implements WhatsNewService {
  readonly #deps: WhatsNewServiceDeps
  readonly #launch = new WritableStore<WhatsNewLaunch>('opening')
  readonly #decision: Store<WhatsNewDecision>
  readonly items: readonly WhatsNewItem[]
  readonly phase: Store<WhatsNewPhase>
  readonly override: Store<boolean>

  constructor(deps: WhatsNewServiceDeps) {
    this.#deps = deps
    const { storage, platform, window, blocked, content } = deps
    const isMainWindow = window.isMainWindow()
    const items = (content[marketingVersion(platform.appVersion)] ?? []).filter((item) => {
      return item.platforms.includes(platform.appPlatform)
    })
    this.items = items
    this.override = deriveStore(
      storage.session.store(WHATS_NEW_OVERRIDE_STORAGE_KEY),
      selectIsOverride,
    )
    this.#decision = combineStores(
      [storage.local.store(WHATS_NEW_SEEN_STORAGE_KEY), this.override, blocked, this.#launch],
      (seen, override, blockedValue, launch) => {
        return decideWhatsNew({
          isMainWindow,
          isDev: platform.isDev,
          items,
          seen: seen === platform.appVersion,
          override,
          blocked: blockedValue,
          launch,
        })
      },
    )
    this.phase = deriveStore(this.#decision, (decision): WhatsNewPhase => {
      return decision === 'show' ? 'shown' : 'hidden'
    })
  }

  readonly setOverride = (next: boolean): void => {
    this.#deps.storage.session.set(WHATS_NEW_OVERRIDE_STORAGE_KEY, next ? 'true' : null)
  }

  readonly dismiss = (): void => {
    this.#markSeen()
    this.setOverride(false)
  }

  #markSeen(): void {
    this.#deps.storage.local.set(WHATS_NEW_SEEN_STORAGE_KEY, this.#deps.platform.appVersion)
  }

  start(): Unlisten {
    const { graphSession } = this.#deps
    // Only the statuses before the first open count: a later graph switch
    // also passes through 'choosing'.
    let setupSeen = false
    const followLaunch = (): void => {
      const { status } = graphSession.get()
      if (status === 'choosing') {
        setupSeen = true
      } else if (status === 'ready') {
        this.#launch.set(setupSeen ? 'openedAfterSetup' : 'opened')
        stopLaunch()
      }
    }
    const stopLaunch = graphSession.subscribe(followLaunch)
    followLaunch()

    const markSkipped = (): void => {
      if (this.#decision.get() === 'skip') {
        this.#markSeen()
      }
    }
    const stopDecision = this.#decision.subscribe(markSkipped)
    markSkipped()

    return () => {
      stopLaunch()
      stopDecision()
    }
  }
}

/**
 * What's New over the app version, local storage, and the given blocker.
 */
export function createWhatsNewService(deps: WhatsNewServiceDeps): WhatsNewService {
  return new WhatsNewServiceImpl(deps)
}
