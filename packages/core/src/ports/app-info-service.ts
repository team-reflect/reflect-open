import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'

/**
 * Facts about the running application build.
 */
export interface AppInfoService {
  /**
   * The application version reported by the native shell.
   */
  version(): MaybePromise<string>
}

const appVersionSchema = z.string()

export interface AppInfoServiceDeps {
  readonly ipc: IpcBridgeService
}

class AppInfoServiceImpl implements AppInfoService {
  readonly #deps: AppInfoServiceDeps

  constructor(deps: AppInfoServiceDeps) {
    this.#deps = deps
  }

  async version(): Promise<string> {
    return await this.#deps.ipc.call('app_version', {}, appVersionSchema)
  }
}

/**
 * App info over the `app_version` command.
 */
export function createAppInfoService(deps: AppInfoServiceDeps): AppInfoService {
  return new AppInfoServiceImpl(deps)
}

/**
 * The version with any prerelease tag or build metadata stripped:
 * `0.6.0-beta.6` becomes `0.6.0`. Matches how Tauri renders
 * `CFBundleShortVersionString` (Apple allows only three numeric parts), so
 * mobile Settings shows the same version as the App Store listing and a
 * promoted TestFlight build never surfaces `-beta.N` to production users.
 */
export function marketingVersion(version: string): string {
  return version.replace(/[-+].*$/, '')
}
