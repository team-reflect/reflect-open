import type { LoggerService } from '../ports/logger-service.ts'
import type { IpcBridgeService } from './ipc-service.ts'
import { definePluginCommand, ignoredResult } from './plugin.ts'

/**
 * Typed bindings for `plugins/tauri-plugin-mobile-haptics`, the app's
 * single haptic.
 */

const impactLightCommand = definePluginCommand<Record<string, never>, unknown>(
  'mobile-haptics',
  'impact_light',
  ignoredResult,
)

/**
 * The haptic engine.
 */
export interface HapticsService {
  /**
   * Fire a light impact haptic. Never rejects: where the plugin is missing
   * (desktop, browser dev), the first failure logs one warning and every
   * later call resolves without an IPC round-trip.
   */
  impactLight(): Promise<void>
}

export interface HapticsServiceDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

class HapticsServiceImpl implements HapticsService {
  readonly #deps: HapticsServiceDeps
  #available = true

  constructor(deps: HapticsServiceDeps) {
    this.#deps = deps
  }

  async impactLight(): Promise<void> {
    if (!this.#available) {
      return
    }
    try {
      await impactLightCommand(this.#deps.ipc, {})
    } catch (error) {
      // Several calls can be in flight before the first rejection lands;
      // only one of them warns.
      if (!this.#available) {
        return
      }
      this.#available = false
      this.#deps.logger.warn('haptics unavailable', error)
    }
  }
}

export function createHapticsService(deps: HapticsServiceDeps): HapticsService {
  return new HapticsServiceImpl(deps)
}
