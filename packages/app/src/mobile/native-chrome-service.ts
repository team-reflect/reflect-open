import type { ClockService, Unlisten } from '@reflect/core'

/**
 * The shell side of the native chrome: where the page's chrome messages go,
 * and where the shell's intents come from.
 */
export interface NativeChromeHost {
  /**
   * Send one chrome message to the shell.
   */
  post(message: object): void
  /**
   * Subscribe to the shell's intents; returns the unsubscribe.
   */
  listenIntent(listener: (payload: unknown) => void): Unlisten
}

/**
 * Whether the shell draws the mobile chrome (navigation bar, tab bar, and
 * keyboard toolbar) natively, and the messages between the page and the
 * shell. Without a host the web draws its own chrome, and every message
 * goes nowhere.
 */
export interface NativeChromeService {
  /**
   * Whether the shell draws the mobile chrome.
   */
  readonly enabled: boolean
  /**
   * Post `state` when it differs from the last one, with the next
   * `generation`, so the shell drops a state older than one it has.
   */
  postState(state: object): void
  /**
   * Post one message that is not a state.
   */
  post(message: object): void
  /**
   * Subscribe to the shell's intents; returns the unsubscribe. One listener
   * at a time. An intent that arrives with no listener is dropped, never kept
   * for a later listener: it was a tap on a page that is gone.
   */
  listenIntent(listener: (payload: unknown) => void): Unlisten
}

export interface NativeChromeServiceDeps {
  /**
   * The shell; without one the service is disabled.
   */
  host: NativeChromeHost | undefined
  clock: ClockService
}

class NativeChromeServiceImpl implements NativeChromeService {
  readonly enabled: boolean
  readonly #host: NativeChromeHost | undefined
  // Starts at the load time, so the states of a reloaded page stay newer
  // than the ones the shell saw before.
  #generation: number
  #lastStateJSON = ''
  #listener: ((payload: unknown) => void) | null = null
  #subscribed = false

  constructor({ host, clock }: NativeChromeServiceDeps) {
    this.#host = host
    this.enabled = host !== undefined
    this.#generation = clock.now()
  }

  postState(state: object): void {
    if (this.#host === undefined) {
      return
    }
    const json = JSON.stringify(state)
    if (json === this.#lastStateJSON) {
      return
    }
    this.#lastStateJSON = json
    this.#generation += 1
    this.#host.post({ ...state, generation: this.#generation })
  }

  post(message: object): void {
    this.#host?.post(message)
  }

  listenIntent(listener: (payload: unknown) => void): Unlisten {
    if (this.#host !== undefined && !this.#subscribed) {
      this.#subscribed = true
      this.#host.listenIntent((payload) => {
        this.#listener?.(payload)
      })
    }
    this.#listener = listener
    return () => {
      if (this.#listener === listener) {
        this.#listener = null
      }
    }
  }
}

export function createNativeChromeService(deps: NativeChromeServiceDeps): NativeChromeService {
  return new NativeChromeServiceImpl(deps)
}
