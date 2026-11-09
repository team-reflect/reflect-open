import {
  combineStores,
  deriveStore,
  marketingVersion,
  WritableStore,
  type GraphSessionService,
  type BuildPlatform,
  type PlatformFacts,
  type StorageService,
  type Store,
  type Unlisten,
} from '@reflect/core'
import { z } from 'zod'
import type { WindowService } from '../app/window-service.ts'
import type { WhatsNewItem } from './whats-new-content.ts'

/**
 * A JSON array of the ids of the current version's items the user saw or skipped.
 */
export const WHATS_NEW_SEEN_STORAGE_KEY = 'reflect.whats-new.seen'

/**
 * Forces What's New on for QA, for this session only.
 */
export const WHATS_NEW_OVERRIDE_STORAGE_KEY = 'reflect.whats-new.override'

/**
 * Everything {@link decideWhatsNew} reads.
 */
export interface WhatsNewInputs {
  readonly isMainWindow: boolean
  readonly isDev: boolean
  /**
   * The items to show.
   */
  readonly items: readonly WhatsNewItem[]
  /**
   * The user already saw or skipped every item of the current version.
   */
  readonly seen: boolean
  readonly override: boolean
  /**
   * Something with priority, like the paywall, shows or may show.
   */
  readonly blocked: boolean
  /**
   * The first graph of this launch opened.
   */
  readonly graphOpened: boolean
  /**
   * Offer What's New first, and show it only once the user accepts.
   */
  readonly offerFirst: boolean
  /**
   * The user accepted the offer in this session.
   */
  readonly accepted: boolean
}

/**
 * The build target whose items to show. Browser dev has no Tauri build target,
 * so it stands in the closest one.
 */
export function whatsNewPlatform(platform: PlatformFacts): BuildPlatform {
  if (platform.buildPlatform) return platform.buildPlatform
  if (platform.appPlatform !== 'desktop') return platform.appPlatform
  return platform.isApplePlatform ? 'darwin' : 'windows'
}

/**
 * `wait` shows nothing for now; `offer` asks the user first; `show` shows the items.
 */
export type WhatsNewDecision = 'wait' | 'offer' | 'show'

/**
 * Whether What's New is hidden, offered, or shown.
 */
export type WhatsNewPhase = 'hidden' | 'offered' | 'shown'

const PHASES: Record<WhatsNewDecision, WhatsNewPhase> = {
  wait: 'hidden',
  offer: 'offered',
  show: 'shown',
}

/**
 * What to do with What's New for the given inputs.
 */
export function decideWhatsNew(inputs: WhatsNewInputs): WhatsNewDecision {
  if (!inputs.isMainWindow || !inputs.graphOpened || inputs.blocked) {
    return 'wait'
  }
  if (inputs.override) {
    return inputs.items.length > 0 ? 'show' : 'wait'
  }
  if (inputs.isDev || inputs.seen) {
    return 'wait'
  }
  return inputs.offerFirst && !inputs.accepted ? 'offer' : 'show'
}

function selectIsOverride(value: string | null): boolean {
  return value === 'true'
}

const seenIdsSchema = z.array(z.string())

/**
 * The seen ids in the stored value. A value that is not a JSON array of strings holds none.
 */
function parseSeenIds(value: string | null): ReadonlySet<string> {
  try {
    return new Set(seenIdsSchema.parse(JSON.parse(value ?? '[]')))
  } catch {
    return new Set()
  }
}

/**
 * The What's New page shown after an update that brings items the user has
 * not seen.
 */
export interface WhatsNewService {
  /**
   * The current version's items for this platform that the user had not seen
   * at launch, or all of them when the user had seen every one.
   */
  readonly items: readonly WhatsNewItem[]
  /**
   * Whether What's New is hidden, offered, or shown.
   */
  readonly phase: Store<WhatsNewPhase>
  /**
   * Whether QA forces What's New on in this session.
   */
  readonly override: Store<boolean>
  setOverride: (next: boolean) => void
  /**
   * Turns the offer into What's New itself.
   */
  accept: () => void
  /**
   * Marks the current version's items as seen while they are still only offered.
   */
  decline: () => void
  /**
   * Marks the current version's items as seen and turns the override off.
   */
  dismiss: () => void
  /**
   * Follows how this launch opens its first graph, and marks the items seen
   * when it opens after the graph chooser or the onboarding (a new install).
   * Call it before the graph boot. Returns the function
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
  /**
   * Offer What's New first instead of showing it right away.
   */
  readonly offerFirst: boolean
}

class WhatsNewServiceImpl implements WhatsNewService {
  readonly #deps: WhatsNewServiceDeps
  readonly #graphOpened = new WritableStore(false)
  readonly #accepted = new WritableStore(false)
  readonly #seen: WritableStore<boolean>
  readonly #decision: Store<WhatsNewDecision>
  readonly #versionIds: readonly string[]
  readonly items: readonly WhatsNewItem[]
  readonly phase: Store<WhatsNewPhase>
  readonly override: Store<boolean>

  constructor(deps: WhatsNewServiceDeps) {
    this.#deps = deps
    const { storage, platform, window, blocked, content, offerFirst } = deps
    const isMainWindow = window.isMainWindow()
    const versionItems = content[marketingVersion(platform.appVersion)] ?? []
    this.#versionIds = versionItems.map((item) => item.id)
    const platformItems = versionItems.filter((item) => {
      return item.platforms.includes(whatsNewPlatform(platform))
    })
    const seenIds = parseSeenIds(storage.local.get(WHATS_NEW_SEEN_STORAGE_KEY))
    const unseenItems = platformItems.filter((item) => !seenIds.has(item.id))
    // Opening What's New again after seeing every item shows them all.
    const items = unseenItems.length > 0 ? unseenItems : platformItems
    this.items = items
    this.#seen = new WritableStore(unseenItems.length === 0)
    this.override = deriveStore(
      storage.session.store(WHATS_NEW_OVERRIDE_STORAGE_KEY),
      selectIsOverride,
    )
    this.#decision = combineStores(
      [this.#seen, this.override, blocked, this.#graphOpened, this.#accepted],
      (seen, override, blockedValue, graphOpened, accepted) => {
        return decideWhatsNew({
          isMainWindow,
          isDev: platform.isDev,
          items,
          seen,
          override,
          blocked: blockedValue,
          graphOpened,
          offerFirst,
          accepted,
        })
      },
    )
    this.phase = deriveStore(this.#decision, (decision) => PHASES[decision])
  }

  readonly setOverride = (next: boolean): void => {
    this.#deps.storage.session.set(WHATS_NEW_OVERRIDE_STORAGE_KEY, next ? 'true' : null)
  }

  readonly accept = (): void => {
    this.#accepted.set(true)
  }

  readonly decline = (): void => {
    if (this.#decision.get() === 'offer') {
      this.#markSeen()
    }
  }

  readonly dismiss = (): void => {
    this.#markSeen()
    this.setOverride(false)
  }

  #markSeen(): void {
    this.#deps.storage.local.set(WHATS_NEW_SEEN_STORAGE_KEY, JSON.stringify(this.#versionIds))
    this.#seen.set(true)
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
        if (setupSeen) {
          this.#markSeen()
        }
        this.#graphOpened.set(true)
        stopLaunch()
      }
    }
    const stopLaunch = graphSession.subscribe(followLaunch)
    followLaunch()

    return stopLaunch
  }
}

/**
 * What's New over the app version, local storage, and the given blocker.
 */
export function createWhatsNewService(deps: WhatsNewServiceDeps): WhatsNewService {
  return new WhatsNewServiceImpl(deps)
}
