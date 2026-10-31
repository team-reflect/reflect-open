import { createGraphSession, type GraphRole } from '../graph/graph-session.ts'
import { createNoteRowService } from '../documents/note-row-service.ts'
import {
  createGraphSessionService,
  type GraphReleaseReason,
  type GraphSessionService,
  type GraphSessionServiceDeps,
  type GraphSessionState,
} from '../graph/graph-session-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { GraphInfo, RecentGraph } from '../graph/schemas.ts'
import { createTestFileChangeService } from './file-change.ts'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { createTestNoteMoveService } from './documents.ts'
import { createTestNoteFileService } from './graph.ts'
import { createTestIdService } from './id.ts'
import { createTestIndexLifecycleService } from './index-lifecycle.ts'
import { createTestIndexStoreService } from './index-store.ts'
import { createTestIpcBridgeService } from './ipc.ts'
import { createTestLoggerService } from './logger.ts'
import { createTestMobileStorageService } from './mobile-storage.ts'
import { createTestICloudNativeService } from './sync.ts'

/**
 * An open graph as a test names it. The defaults are the graph `test` at
 * `/graphs/test` with both generations 1. `indexGeneration: null` is a graph
 * whose index failed to open.
 */
export interface TestOpenGraph {
  root?: string
  name?: string
  generation?: number
  indexGeneration?: number | null
}

/**

 * The services a test graph session runs on; each defaults to a fresh test double.

 */
export interface TestGraphSessionServiceOptions<Services = unknown> extends Partial<
  GraphSessionServiceDeps<Services>
> {
  /**
   * Start with this graph open (or with none), as {@link TestGraphSessionService.setGraph} does.
   */
  graph?: TestOpenGraph | null
  /**
   * Reported over the real state from the start, as {@link TestGraphSessionService.setState} does.
   */
  state?: Partial<GraphSessionState<Services>>
  /**
   * What the default `ipc` answers for `recent_graphs`. Unused when `ipc` is given.
   */
  recents?: readonly RecentGraph[]
}

export interface TestGraphSessionService<Services = unknown> extends GraphSessionService<Services> {
  /**
   * Report `patch` over the real state and notify subscribers.
   */
  setState(patch: Partial<GraphSessionState<Services>>): void
  /**
   * Report `graph` as open and ready without an open flow, or `null` as the
   * graph chooser. The real service's own opens stay hidden behind it. The
   * session of the previous `setGraph` ends, and a graph with an index
   * session gets services from `createServices` when it is given.
   */
  setGraph(graph: TestOpenGraph | null): void
}

function graphPatch(
  graph: TestOpenGraph | null,
  role: GraphRole,
  signal: AbortSignal,
): Partial<GraphSessionState<never>> {
  if (graph === null) {
    return {
      status: 'choosing',
      graph: null,
      indexGeneration: null,
      indexing: false,
      error: null,
      session: null,
      services: null,
    }
  }
  const info = {
    root: graph.root ?? '/graphs/test',
    name: graph.name ?? 'test',
    generation: graph.generation ?? 1,
  }
  const indexGeneration = graph.indexGeneration === undefined ? 1 : graph.indexGeneration
  return {
    status: 'ready',
    graph: info,
    indexGeneration,
    indexing: false,
    error: null,
    session: createGraphSession({ ...info, indexGeneration, role }, signal),
    services: null,
  }
}

function baseName(path: string): string {
  return path.split('/').findLast((segment) => segment !== '') ?? path
}

class TestGraphSessionServiceImpl<Services> implements TestGraphSessionService<Services> {
  readonly #inner: GraphSessionService<Services>
  readonly #role: GraphRole
  readonly #createServices: GraphSessionServiceDeps<Services>['createServices']
  readonly #listeners = new Set<() => void>()
  // Ends the session of the last `setGraph`.
  #seeded = new AbortController()
  #overlay: Partial<GraphSessionState<Services>>
  #merged: {
    base: GraphSessionState<Services>
    overlay: Partial<GraphSessionState<Services>>
  } | null = null
  #snapshot: GraphSessionState<Services>

  constructor(
    inner: GraphSessionService<Services>,
    options: {
      readonly role: GraphRole
      readonly createServices: GraphSessionServiceDeps<Services>['createServices']
      readonly graph: TestOpenGraph | null | undefined
      readonly state: Partial<GraphSessionState<Services>> | undefined
    },
  ) {
    this.#inner = inner
    this.#role = options.role
    this.#createServices = options.createServices
    this.#overlay = {
      ...(options.graph === undefined ? {} : this.#seedGraph(options.graph)),
      ...options.state,
    }
    this.#snapshot = inner.getState()
  }

  readonly getState = (): GraphSessionState<Services> => {
    const base = this.#inner.getState()
    if (this.#merged?.base !== base || this.#merged.overlay !== this.#overlay) {
      this.#merged = { base, overlay: this.#overlay }
      this.#snapshot = { ...base, ...this.#overlay }
    }
    return this.#snapshot
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    const unlisten = this.#inner.subscribe(listener)
    this.#listeners.add(listener)
    return () => {
      unlisten()
      this.#listeners.delete(listener)
    }
  }

  attach(): Unlisten {
    return this.#inner.attach()
  }

  loadRecents(options?: { surfaceErrors?: boolean }): Promise<RecentGraph[]> {
    return this.#inner.loadRecents(options)
  }

  openRecent(root: string): Promise<boolean> {
    return this.#inner.openRecent(root)
  }

  createGraphAt(root: string): Promise<boolean> {
    return this.#inner.createGraphAt(root)
  }

  close(): Promise<void> {
    return this.#inner.close()
  }

  adopt(info: GraphInfo, indexGeneration: number | null): void {
    this.#inner.adopt(info, indexGeneration)
  }

  forgetRecent(root: string): Promise<void> {
    return this.#inner.forgetRecent(root)
  }

  deleteGraph(): Promise<void> {
    return this.#inner.deleteGraph()
  }

  refreshIndex(): void {
    this.#inner.refreshIndex()
  }

  park(error: string | null): void {
    this.#inner.park(error)
  }

  reportError(error: string): void {
    this.#inner.reportError(error)
  }

  onGraphReleased(listener: (reason: GraphReleaseReason) => void): Unlisten {
    return this.#inner.onGraphReleased(listener)
  }

  onGraphDeleted(listener: (root: string) => void): Unlisten {
    return this.#inner.onGraphDeleted(listener)
  }

  setState(patch: Partial<GraphSessionState<Services>>): void {
    this.#overlay = { ...this.#overlay, ...patch }
    for (const listener of this.#listeners) {
      listener()
    }
  }

  setGraph(graph: TestOpenGraph | null): void {
    this.setState(this.#seedGraph(graph))
  }

  #seedGraph(graph: TestOpenGraph | null): Partial<GraphSessionState<Services>> {
    this.#seeded.abort()
    this.#seeded = new AbortController()
    const patch: Partial<GraphSessionState<Services>> = graphPatch(
      graph,
      this.#role,
      this.#seeded.signal,
    )
    const session = patch.session ?? null
    const createServices = this.#createServices
    if (session === null || createServices === undefined) {
      return patch
    }
    return { ...patch, services: createServices(session) }
  }
}

/**
 * The real {@link GraphSessionService} over test doubles, plus state seeding.
 * The default `ipc` opens any root as a graph named after its last path
 * segment, with a generation one above the previous open.
 */
export function createTestGraphSessionService<Services = never>(
  options?: TestGraphSessionServiceOptions<Services>,
): TestGraphSessionService<Services> {
  let recents = [...(options?.recents ?? [])]
  let generation = 0
  const createDefaultIpc = (): GraphSessionServiceDeps['ipc'] => {
    return createTestIpcBridgeService({
      commands: {
        recent_graphs: () => recents,
        forget_recent: (args) => {
          recents = recents.filter((recent) => recent.root !== args['root'])
          return null
        },
        graph_open: (args) => {
          const root = String(args['path'])
          generation += 1
          return { root, name: baseName(root), generation }
        },
        graph_delete: () => null,
      },
    })
  }
  const indexStore = options?.indexStore ?? createTestIndexStoreService()
  const noteFile = options?.noteFile ?? createTestNoteFileService()
  const fileChanges = createTestFileChangeService()
  const logger = options?.logger ?? createTestLoggerService()
  const role = options?.role ?? 'main'
  const createServices = options?.createServices
  const inner: GraphSessionService<Services> = createGraphSessionService<Services>({
    ipc: options?.ipc ?? createDefaultIpc(),
    indexLifecycle:
      options?.indexLifecycle ??
      createTestIndexLifecycleService({ indexStore, noteFile, fileChanges, logger }),
    indexStore,
    noteFile,
    id: options?.id ?? createTestIdService(),
    fileChanges: options?.fileChanges ?? fileChanges,
    role,
    mobileStorage: options?.mobileStorage ?? createTestMobileStorageService(),
    noteRows:
      options?.noteRows ??
      createNoteRowService({
        graphSession: {
          getState: () => testService.getState(),
          subscribe: (listener) => testService.subscribe(listener),
        },
      }),
    openDocuments: options?.openDocuments ?? createOpenDocumentsService({ fileChanges }),
    noteMove: options?.noteMove ?? createTestNoteMoveService(),
    icloudNative: options?.icloudNative ?? createTestICloudNativeService(),
    logger,
    ...(createServices === undefined ? {} : { createServices }),
  })
  const testService: TestGraphSessionService<Services> = new TestGraphSessionServiceImpl<Services>(
    inner,
    {
      role,
      createServices,
      graph: options?.graph,
      state: options?.state,
    },
  )
  return testService
}
