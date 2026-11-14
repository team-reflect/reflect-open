import type { WebAuthOptions } from '@reflect/types'
import type { IpcBridgeService } from './ipc-service.ts'

/**
 * Typed bindings for the `plugin:web-auth` commands, the system web sign-in
 * session (`apps/ios/Sources/Capabilities/WebAuthCapability.swift`).
 */

export type { WebAuthOptions } from '@reflect/types'

/**
 * Opens the system web sign-in and resolves its callback URL, or `null` when cancelled.
 */
export type StartWebAuth = (options: WebAuthOptions) => Promise<string | null>

/**
 * The system web sign-in session.
 */
export interface WebAuthService {
  /**
   * Open `url` in the system web sign-in session and resolve the callback URL
   * it redirects to, or `null` when the user cancels.
   */
  start: StartWebAuth
}

export interface WebAuthServiceDeps {
  readonly ipc: IpcBridgeService
}

class WebAuthServiceImpl implements WebAuthService {
  readonly #deps: WebAuthServiceDeps

  constructor(deps: WebAuthServiceDeps) {
    this.#deps = deps
  }

  async start(options: WebAuthOptions): Promise<string | null> {
    const payload: WebAuthOptions = {
      url: options.url,
      callbackScheme: options.callbackScheme,
      ephemeral: options.ephemeral,
    }
    return (await this.#deps.ipc.call('plugin:web-auth|start', { payload })).url ?? null
  }
}

export function createWebAuthService(deps: WebAuthServiceDeps): WebAuthService {
  return new WebAuthServiceImpl(deps)
}
