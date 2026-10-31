import { z } from 'zod'
import { graphInfoSchema, type GraphInfo } from '../graph/schemas.ts'
import type { IpcBridgeService } from './ipc-service.ts'

const mobileStorageInfoSchema = z.object({
  localRoot: z.string(),
  /**
   * The container's `Documents/` dir when iCloud is usable; new graphs are created inside it.
   */
  icloudDocumentsRoot: z.string().nullable(),
  /**
   * Every graph already in the container (name-sorted); onboarding and the switcher list them.
   */
  icloudGraphRoots: z.array(z.string()),
})

/**
 * Where the mobile graph can live (Plan 21): the app-sandbox `Documents/`
 * directory (always present, never synced) and the app's iCloud Drive
 * container when iCloud is usable, plus every graph the container already
 * holds (a user can keep several).
 */
export type MobileStorageInfo = z.infer<typeof mobileStorageInfoSchema>

/**
 * Which of the {@link MobileStorageInfo} roots the graph lives in.
 */
export type MobileStorageKind = 'icloud' | 'local'

/**
 * The native side of mobile graph storage. iOS container paths change across
 * restore and update: resolve them fresh every launch and never persist them.
 */
export interface MobileStorageService {
  /**
   * Resolve every mobile storage root. Mobile only; the desktop shell rejects it.
   */
  resolve(): Promise<MobileStorageInfo>
  /**
   * The app-sandbox `Documents/` root alone: the cheap half of {@link resolve},
   * available before the iCloud container resolves. Mobile only.
   */
  resolveLocal(): Promise<string>
  /**
   * Create a new graph at `path` and open it.
   */
  createGraph(path: string): Promise<GraphInfo>
}

export interface MobileStorageServiceDeps {
  readonly ipc: IpcBridgeService
}

class MobileStorageServiceImpl implements MobileStorageService {
  readonly #deps: MobileStorageServiceDeps

  constructor(deps: MobileStorageServiceDeps) {
    this.#deps = deps
  }

  resolve(): Promise<MobileStorageInfo> {
    return this.#deps.ipc.call('mobile_storage', {}, mobileStorageInfoSchema)
  }

  resolveLocal(): Promise<string> {
    return this.#deps.ipc.call('mobile_storage_local', {}, z.string())
  }

  createGraph(path: string): Promise<GraphInfo> {
    return this.#deps.ipc.call('graph_create', { path }, graphInfoSchema)
  }
}

export function createMobileStorageService(deps: MobileStorageServiceDeps): MobileStorageService {
  return new MobileStorageServiceImpl(deps)
}
