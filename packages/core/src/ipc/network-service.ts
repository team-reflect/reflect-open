import { z } from 'zod'
import type { IpcBridgeService } from './ipc-service.ts'
import { definePluginEvent } from './plugin.ts'
import { WritableStore, type Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * The service over the `plugin:network` command and event
 * (`apps/ios/Sources/Capabilities/NetworkCapability.swift`).
 */

const changedEvent = definePluginEvent('network', 'changed', z.object({ expensive: z.boolean() }))

/**
 * The cost of the current connection.
 */
export interface NetworkService {
  /**
   * Whether the connection costs the user money or data: cellular, a
   * personal hotspot, or Low Data Mode. `null` until the shell answers, and
   * `false` where the shell has no network plugin (desktop, browser dev).
   */
  readonly expensive: Store<boolean | null>
  /**
   * Follow the shell's network status until the returned function is called.
   */
  watch(): Unlisten
}

export interface NetworkServiceDeps {
  readonly ipc: IpcBridgeService
}

class NetworkServiceImpl implements NetworkService {
  readonly #deps: NetworkServiceDeps
  readonly #expensive = new WritableStore<boolean | null>(null)
  readonly expensive: Store<boolean | null> = this.#expensive

  constructor(deps: NetworkServiceDeps) {
    this.#deps = deps
  }

  watch(): Unlisten {
    const subscription = changedEvent(this.#deps.ipc, ({ expensive }) => {
      this.#expensive.set(expensive)
    })
    void this.#poll(subscription.ready)
    return subscription.unlisten
  }

  // Polls after the listener registers, so no change falls between them.
  async #poll(ready: Promise<void>): Promise<void> {
    try {
      await ready
      const { expensive } = await this.#deps.ipc.call('plugin:network|status', {})
      this.#expensive.set(expensive)
    } catch {
      // A shell without the plugin rejects: the connection is free.
      if (this.#expensive.get() === null) {
        this.#expensive.set(false)
      }
    }
  }
}

export function createNetworkService(deps: NetworkServiceDeps): NetworkService {
  return new NetworkServiceImpl(deps)
}
