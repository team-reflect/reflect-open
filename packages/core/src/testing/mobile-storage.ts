import type { GraphInfo } from '../graph/schemas.ts'
import type { MobileStorageInfo, MobileStorageService } from '../ipc/mobile-storage-service.ts'

export interface TestMobileStorageServiceOptions {
  /**
   * What `resolve` answers. Defaults to a local-only device.
   */
  storage?: MobileStorageInfo
}

export interface TestMobileStorageService extends MobileStorageService {
  /**
   * The path of every `createGraph`, in order.
   */
  createdGraphs(): readonly string[]
}

function baseName(path: string): string {
  return path.split('/').findLast((segment) => segment !== '') ?? path
}

class TestMobileStorageServiceImpl implements TestMobileStorageService {
  readonly #storage: MobileStorageInfo
  readonly #created: string[] = []

  constructor(options?: TestMobileStorageServiceOptions) {
    this.#storage = options?.storage ?? {
      localRoot: '/local/Documents',
      icloudDocumentsRoot: null,
      icloudGraphRoots: [],
    }
  }

  resolve(): Promise<MobileStorageInfo> {
    return Promise.resolve({
      ...this.#storage,
      icloudGraphRoots: [...this.#storage.icloudGraphRoots],
    })
  }

  resolveLocal(): Promise<string> {
    return Promise.resolve(this.#storage.localRoot)
  }

  createGraph(path: string): Promise<GraphInfo> {
    this.#created.push(path)
    return Promise.resolve({ root: path, name: baseName(path), generation: 1 })
  }

  createdGraphs(): readonly string[] {
    return [...this.#created]
  }
}

/**
 * An in-memory {@link MobileStorageService}. `createGraph` answers a graph
 * named after the last path segment, with generation `1`.
 */
export function createTestMobileStorageService(
  options?: TestMobileStorageServiceOptions,
): TestMobileStorageService {
  return new TestMobileStorageServiceImpl(options)
}
