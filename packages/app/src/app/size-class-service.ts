import {
  sizeClassChangedEvent,
  sizeClassCommand,
  type HorizontalSizeClass,
  type IpcBridgeService,
  type LoggerService,
  type PlatformFacts,
  type Store,
  WritableStore,
} from '@reflect/core'
import type { PlatformMedia } from './system-preferences-service.ts'

/**
 * The window's horizontal size class, the signal iPadOS apps lay out by. On
 * an iPad it decides between the desktop workspace (`regular`) and the phone
 * shell (`compact`), so Slide Over, a narrow Split View pane or a small Stage
 * Manager window behave like an iPhone. Elsewhere the answer is fixed: the
 * desktop app is always `regular`, a phone always `compact`.
 *
 * The value is `null` while an iPad has not answered yet: a surface that
 * depends on it waits rather than guessing and remounting.
 */
export interface SizeClassService extends Store<HorizontalSizeClass | null> {
  /**
   * Start following the window. Idempotent; the iPad root calls it before its first render.
   */
  start(): void
}

export interface SizeClassServiceDeps {
  readonly ipc: IpcBridgeService
  readonly platform: PlatformFacts
  readonly logger: LoggerService
  /**
   * The media queries behind the plain-browser fallback; defaults to the global `matchMedia`.
   */
  readonly media?: PlatformMedia | undefined
}

/**
 * Where a browser has no UIKit to ask (`?platform=ipad` dev, or a build whose
 * scene plugin failed), width stands in. iPadOS turns regular somewhere
 * between half of an 11-inch iPad in landscape (compact) and half of a
 * 13-inch one (regular), so this is an approximation, never the shipped rule.
 */
const REGULAR_WIDTH_QUERY = '(min-width: 640px)'

class SizeClassServiceImpl implements SizeClassService {
  readonly #deps: SizeClassServiceDeps
  readonly #state: WritableStore<HorizontalSizeClass | null>
  readonly get: Store<HorizontalSizeClass | null>['get']
  readonly subscribe: Store<HorizontalSizeClass | null>['subscribe']
  #started = false

  constructor(deps: SizeClassServiceDeps) {
    this.#deps = deps
    const { platform } = deps
    this.#state = new WritableStore<HorizontalSizeClass | null>(
      platform.isTablet ? null : platform.appPlatform === 'desktop' ? 'regular' : 'compact',
    )
    this.get = this.#state.get
    this.subscribe = this.#state.subscribe
  }

  start(): void {
    if (this.#started || !this.#deps.platform.isTablet) {
      return
    }
    this.#started = true
    if (this.#deps.platform.isNativeShell) {
      void this.#followScene()
    } else {
      this.#followMedia()
    }
  }

  async #followScene(): Promise<void> {
    const { ipc, logger } = this.#deps
    // Subscribe before the first read, so a change between the two still lands.
    const subscription = sizeClassChangedEvent(ipc, (payload) =>
      this.#state.set(payload.horizontal),
    )
    try {
      await subscription.ready
      const { horizontal } = await sizeClassCommand(ipc, {})
      // An event that landed during the read is newer than its answer.
      if (this.#state.get() === null) {
        this.#state.set(horizontal)
      }
    } catch (error) {
      subscription.unlisten()
      logger.warn('the scene plugin is unavailable; following the window width instead', error)
      this.#followMedia()
    }
  }

  #followMedia(): void {
    const matchMedia =
      this.#deps.media?.matchMedia ??
      (typeof globalThis.matchMedia === 'function'
        ? (query: string) => globalThis.matchMedia(query)
        : undefined)
    if (matchMedia === undefined) {
      this.#state.set('regular')
      return
    }
    const query = matchMedia(REGULAR_WIDTH_QUERY)
    const publishQuery = (): void => this.#state.set(query.matches ? 'regular' : 'compact')
    query.addEventListener('change', publishQuery)
    publishQuery()
  }
}

export function createSizeClassService(deps: SizeClassServiceDeps): SizeClassService {
  return new SizeClassServiceImpl(deps)
}
