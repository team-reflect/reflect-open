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
  /**
   * Memory, uptime, and OS facts of the native process.
   */
  processDiagnostics(): MaybePromise<ProcessDiagnostics>
}

const appVersionSchema = z.string()

const processDiagnosticsSchema = z.object({
  /**
   * The physical footprint (Activity Monitor's Memory); null where the
   * platform has no such number.
   */
  footprintBytes: z.number().nullable(),
  uptimeMs: z.number(),
  os: z.string(),
  osVersion: z.string().nullable(),
  arch: z.string(),
})

export type ProcessDiagnostics = z.infer<typeof processDiagnosticsSchema>

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

  async processDiagnostics(): Promise<ProcessDiagnostics> {
    return await this.#deps.ipc.call('process_diagnostics', {}, processDiagnosticsSchema)
  }
}

/**
 * App info over the `app_version` and `process_diagnostics` commands.
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
