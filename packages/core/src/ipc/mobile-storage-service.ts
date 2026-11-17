import type { MobileStorageInfo } from '@reflect/types'
import type { GraphInfo } from '../graph/schemas.ts'
import type { IpcBridgeService } from './ipc-service.ts'

export type { MobileStorageInfo } from '@reflect/types'

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
    return this.#deps.ipc.call('mobile_storage', {})
  }

  resolveLocal(): Promise<string> {
    return this.#deps.ipc.call('mobile_storage_local', {})
  }

  createGraph(path: string): Promise<GraphInfo> {
    return this.#deps.ipc.call('graph_create', { path })
  }
}

export function createMobileStorageService(deps: MobileStorageServiceDeps): MobileStorageService {
  return new MobileStorageServiceImpl(deps)
}
