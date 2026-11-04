import { isShallowEqual } from '@ocavue/utils'
import {
  combineStores,
  deriveStore,
  marketingVersion,
  WritableStore,
  type ActivityPort,
  type AppInfoService,
  type DeepLinkIntakeService,
  type GraphStatus,
  type LoggerService,
  type PlatformFacts,
  type StorageService,
  type Store,
  type Unlisten,
} from '@reflect/core'
import type { WindowService } from '../app/window-service.ts'
import type { WhatsNewItem, WhatsNewPlatform } from './whats-new-content.ts'

/**
 * The full version, prerelease tag included, whose What's New the user last saw or skipped.
 */
export const WHATS_NEW_SEEN_STORAGE_KEY = 'reflect.whats-new.seen'

/**
 * Forces What's New on for QA, for this session only.
 */
export const WHATS_NEW_OVERRIDE_STORAGE_KEY = 'reflect.whats-new.override'

/**
 * Whether something with priority, like the paywall, holds What's New back:
 * `pending` until it is known, `blocked` while it shows, `clear` otherwise.
 */
export type WhatsNewBlocker = 'pending' | 'clear' | 'blocked'

/**
 * Everything {@link decideWhatsNew} reads.
 */
export interface WhatsNewInputs {
  readonly isMainWindow: boolean
  readonly isDev: boolean
  readonly platform: WhatsNewPlatform | null
  /**
   * The full app version; `null` until it is read.
   */
  readonly version: string | null
  readonly seen: string | null
  readonly override: boolean
  readonly blocker: WhatsNewBlocker
  /**
   * This launch showed the graph chooser or the onboarding before it opened a graph.
   */
  readonly setupSeen: boolean
  /**
   * A deep link arrived since the app last became visible.
   */
  readonly deepLinkSeen: boolean
}

/**
 * `wait` shows nothing for now; `skip` shows nothing and marks the version
 * seen; `show` shows the items.
 */
export type WhatsNewDecision =
  | { readonly kind: 'wait'; readonly items?: undefined }
  | { readonly kind: 'skip'; readonly items?: undefined }
  | { readonly kind: 'show'; readonly items: readonly WhatsNewItem[] }

/**
 * Whether to show What's New, and its items.
 */
export type WhatsNewGate =
  | { readonly kind: 'hidden'; readonly items?: undefined }
  | { readonly kind: 'whatsNew'; readonly items: readonly WhatsNewItem[] }

const WAIT: WhatsNewDecision = { kind: 'wait' }
const SKIP: WhatsNewDecision = { kind: 'skip' }
const HIDDEN: WhatsNewGate = { kind: 'hidden' }

function filterItems(
  items: readonly WhatsNewItem[] | undefined,
  platform: WhatsNewPlatform,
): WhatsNewItem[] {
  return (items ?? []).filter((item) => item.platforms.includes(platform))
}

/**
 * What to do with What's New for the given inputs and content.
 */
export function decideWhatsNew(
  inputs: WhatsNewInputs,
  content: Readonly<Record<string, readonly WhatsNewItem[]>>,
): WhatsNewDecision {
  const { platform, version } = inputs
  if (!inputs.isMainWindow || platform === null || version === null) {
    return WAIT
  }
  if (inputs.blocker !== 'clear') {
    return WAIT
  }
  const items = filterItems(content[marketingVersion(version)], platform)
  if (inputs.override) {
    if (items.length > 0) {
      return { kind: 'show', items }
    }
    const newest = Object.values(content)[0]
    const fallback = filterItems(newest, platform)
    return fallback.length > 0 ? { kind: 'show', items: fallback } : WAIT
  }
  if (inputs.isDev || inputs.seen === version) {
    return WAIT
  }
  if (inputs.setupSeen || items.length === 0) {
    return SKIP
  }
  if (inputs.deepLinkSeen) {
    return WAIT
  }
  return { kind: 'show', items }
}

function isDecisionEqual(a: WhatsNewDecision, b: WhatsNewDecision): boolean {
  return a.kind === b.kind && isShallowEqual(a.items ?? [], b.items ?? [])
}

function toGate(decision: WhatsNewDecision): WhatsNewGate {
  return decision.kind === 'show' ? { kind: 'whatsNew', items: decision.items } : HIDDEN
}

function toWhatsNewPlatform(platform: PlatformFacts): WhatsNewPlatform | null {
  switch (platform.appPlatform) {
    case 'desktop':
      return 'desktop'
    case 'ios':
      return 'ios'
    case 'android':
      return null
  }
}

function selectIsOverride(value: string | null): boolean {
  return value === 'true'
}

/**
 * The What's New page shown once per app version after an update.
 */
export interface WhatsNewService {
  /**
   * Whether to show What's New, and its items.
   */
  readonly gate: Store<WhatsNewGate>
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
   * Reads the app version, follows the setup and deep-link signals, and marks
   * a version seen when it should never show. Call it before the graph boot.
   * Returns the function that stops it.
   */
  start(): Unlisten
}

export interface WhatsNewServiceDeps {
  readonly storage: StorageService
  readonly appInfo: AppInfoService
  readonly platform: PlatformFacts
  readonly window: WindowService
  readonly graphSession: Store<{ readonly status: GraphStatus }>
  readonly intake: DeepLinkIntakeService
  readonly activity: ActivityPort
  readonly blocker: Store<WhatsNewBlocker>
  readonly content: Readonly<Record<string, readonly WhatsNewItem[]>>
  readonly logger: LoggerService
}

class WhatsNewServiceImpl implements WhatsNewService {
  readonly #deps: WhatsNewServiceDeps
  readonly #version = new WritableStore<string | null>(null)
  readonly #setupSeen = new WritableStore(false)
  readonly #deepLinkSeen = new WritableStore(false)
  readonly #decision: Store<WhatsNewDecision>
  readonly gate: Store<WhatsNewGate>
  readonly override: Store<boolean>

  constructor(deps: WhatsNewServiceDeps) {
    this.#deps = deps
    const { storage, platform, window, blocker, content } = deps
    const isMainWindow = window.isMainWindow()
    const whatsNewPlatform = toWhatsNewPlatform(platform)
    this.override = deriveStore(
      storage.session.store(WHATS_NEW_OVERRIDE_STORAGE_KEY),
      selectIsOverride,
    )
    this.#decision = combineStores(
      [
        this.#version,
        storage.local.store(WHATS_NEW_SEEN_STORAGE_KEY),
        this.override,
        blocker,
        this.#setupSeen,
        this.#deepLinkSeen,
      ],
      (version, seen, override, blockerValue, setupSeen, deepLinkSeen) => {
        return decideWhatsNew(
          {
            isMainWindow,
            isDev: platform.isDev,
            platform: whatsNewPlatform,
            version,
            seen,
            override,
            blocker: blockerValue,
            setupSeen,
            deepLinkSeen,
          },
          content,
        )
      },
      isDecisionEqual,
    )
    this.gate = deriveStore(this.#decision, toGate)
  }

  readonly setOverride = (next: boolean): void => {
    this.#deps.storage.session.set(WHATS_NEW_OVERRIDE_STORAGE_KEY, next ? 'true' : null)
  }

  readonly dismiss = (): void => {
    this.#markSeen()
    this.setOverride(false)
  }

  #markSeen(): void {
    const version = this.#version.get()
    if (version !== null) {
      this.#deps.storage.local.set(WHATS_NEW_SEEN_STORAGE_KEY, version)
    }
  }

  start(): Unlisten {
    const { graphSession, intake, activity, appInfo, logger } = this.#deps
    let active = true

    // Only the statuses before the first open count: a later graph switch
    // also passes through 'choosing'.
    let stopSetup: Unlisten | null = null
    const followSetup = (): void => {
      const { status } = graphSession.get()
      if (status === 'choosing') {
        this.#setupSeen.set(true)
      } else if (status === 'ready') {
        stopSetup?.()
        stopSetup = null
      }
    }
    stopSetup = graphSession.subscribe(followSetup)
    followSetup()

    const markSkipped = (): void => {
      if (this.#decision.get().kind === 'skip') {
        this.#markSeen()
      }
    }
    const unlisteners: Unlisten[] = [
      intake.onUrl(() => this.#deepLinkSeen.set(true)),
      activity.subscribeHidden(() => this.#deepLinkSeen.set(false)),
      this.#decision.subscribe(markSkipped),
    ]
    markSkipped()

    void (async () => {
      try {
        const version = await appInfo.version()
        if (active) {
          this.#version.set(version)
        }
      } catch (err) {
        logger.warn("What's New could not read the app version", err)
      }
    })()

    return () => {
      active = false
      stopSetup?.()
      for (const unlisten of unlisteners.splice(0)) {
        unlisten()
      }
    }
  }
}

/**
 * What's New over the app version, local storage, and the given blocker.
 */
export function createWhatsNewService(deps: WhatsNewServiceDeps): WhatsNewService {
  return new WhatsNewServiceImpl(deps)
}
