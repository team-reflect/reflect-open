import {
  sizeClassChangedEvent,
  sizeClassCommand,
  type HorizontalSizeClass,
  type IpcBridgeService,
  type LoggerService,
  type PlatformFacts,
  type Unlisten,
} from '@reflect/core'
import type { PlatformMedia } from './platform-service.ts'

/**
 * The window's horizontal size class, the signal iPadOS apps lay out by. On
 * an iPad it decides between the desktop workspace (`regular`) and the phone
 * shell (`compact`), so Slide Over, a narrow Split View pane or a small Stage
 * Manager window behave like an iPhone. Elsewhere the answer is fixed: the
 * desktop app is always `regular`, a phone always `compact`.
 *
 * Members are function properties so React can hand them to
 * `useSyncExternalStore` unbound.
 */
export interface SizeClassService {
  /**
   * The current size class, or `null` while an iPad has not answered yet:
   * a surface that depends on it waits rather than guessing and remounting.
   */
  current: () => HorizontalSizeClass | null
  /**
   * Listen for a changed size class.
   */
  subscribe: (listener: () => void) => Unlisten
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
  readonly #listeners = new Set<() => void>()
  #current: HorizontalSizeClass | null
  #started = false

  constructor(deps: SizeClassServiceDeps) {
    this.#deps = deps
    const { platform } = deps
    this.#current = platform.isTablet
      ? null
      : platform.appPlatform === 'desktop'
        ? 'regular'
        : 'compact'
  }

  readonly current = (): HorizontalSizeClass | null => this.#current

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
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
    const subscription = sizeClassChangedEvent(ipc, (payload) => this.#publish(payload.horizontal))
    try {
      await subscription.ready
      const { horizontal } = await sizeClassCommand(ipc, {})
      // An event that landed during the read is newer than its answer.
      if (this.#current === null) {
        this.#publish(horizontal)
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
      this.#publish('regular')
      return
    }
    const query = matchMedia(REGULAR_WIDTH_QUERY)
    const publishQuery = (): void => this.#publish(query.matches ? 'regular' : 'compact')
    query.addEventListener('change', publishQuery)
    publishQuery()
  }

  #publish(sizeClass: HorizontalSizeClass): void {
    if (sizeClass === this.#current) {
      return
    }
    this.#current = sizeClass
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createSizeClassService(deps: SizeClassServiceDeps): SizeClassService {
  return new SizeClassServiceImpl(deps)
}
