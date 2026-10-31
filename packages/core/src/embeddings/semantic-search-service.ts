import type { GraphRole } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { StorageService } from '../ports/storage-service.ts'
import type { GraphSessionState } from '../graph/graph-session-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { EmbeddingIndexService } from './embedding-index-service.ts'
import type { EmbeddingRuntimeService, EmbedStatus } from './embedding-runtime-service.ts'
import type { RetrievalHit, RetrievalService } from './retrieval-service.ts'

/**

 * Where the opt-in lived before it moved into the settings document.

 */
const LEGACY_ENABLED_KEY = 'reflect.semantic.enabled'

const SIMILAR_NOTES_LIMIT = 6

/**

 * The open graph as {@link SemanticSearchService} reads it; a `GraphSessionService` is one.

 */
export interface SemanticSearchGraphSource {
  getState: () => Pick<GraphSessionState, 'graph' | 'indexGeneration'>
  subscribe: (listener: () => void) => Unlisten
}

/**
 * The user-facing side of the optional local semantic search (Plan 09). The
 * model is ~90MB and downloads from the network, so it is **opt-in**: the
 * `semanticSearchEnabled` setting is the persisted opt-in, and a started
 * service kicks the first download; later launches auto-load from the local
 * cache because the flag is set. Acceptance: "first semantic use downloads
 * the model with progress; later uses are instant."
 *
 * From its creation the service also re-embeds after each requested index
 * rebuild (`IndexLifecycleService.onReconciled` with `source: 'rebuild'`):
 * `index_clear` wiped the embedding tables with everything else, and semantic
 * search would otherwise stay silently empty until some other trigger
 * re-embedded. The rebuild request stays in flight until that backfill ends.
 */
export interface SemanticSearchService {
  /**
   * Keep embeddings in sync with the open graph until the returned function
   * is called. Three jobs:
   *
   * - load the model whenever `semanticSearchEnabled` is on and the runtime is
   *   untouched — at launch for users who opted in earlier (the cache makes
   *   that instant) and the moment the setting flips on (the one place the
   *   first download starts). Deliberately not retried on `failed`: an
   *   automatic loop would hammer a broken download — recovery rides the
   *   explicit enable/retry actions instead (see
   *   {@link SemanticSearchService.retryFailedModel});
   * - run one incremental backfill per (graph, model) once `ready` (hash-skip
   *   makes this cheap when nothing changed);
   * - follow the index: changed notes re-embed, deleted notes drop vectors.
   *
   * Backfill and follow work need the runtime `ready` *and* the setting on:
   * disabling semantic search pauses embedding work immediately (the loaded
   * model just idles for the rest of the session), and re-enabling catches up
   * via the cheap hash-skip backfill. Main window only: a secondary note
   * window loading the model and re-embedding on the same watcher stream
   * would duplicate every write.
   *
   * Starting also carries the opt-in over from where it lived before the
   * settings document (`localStorage`), once, so those users keep semantic
   * search across the move.
   */
  start(): Unlisten
  /**
   * Load (downloading if needed) the model. Resolves with the outcome.
   */
  ensureModel(): Promise<EmbedStatus>
  /**
   * Re-kick a `failed` model load; a no-op for every other status. The explicit
   * enable actions (settings button, `semantic.enable` command) run this so
   * opting back in after a failure retries the download — a started service
   * itself only loads an `uninitialized` runtime, because reacting to `failed`
   * would loop a broken download forever.
   */
  retryFailedModel(): Promise<void>
  /**
   * The semantic neighbors of the note at `path` ("Similar notes"), at most
   * six. A costly read (see `RetrievalService.relatedNotes`): callers own
   * their refresh cadence.
   */
  similarNotes(path: string): Promise<RetrievalHit[]>
  /**
   * Stop re-embedding after index rebuilds. The service is unusable afterwards.
   */
  dispose(): void
}

export interface SemanticSearchServiceDeps {
  readonly embeddingRuntime: EmbeddingRuntimeService
  readonly embeddingIndex: EmbeddingIndexService
  readonly retrieval: RetrievalService
  readonly settings: SettingsService
  readonly storage: StorageService
  readonly role: GraphRole
  readonly indexLifecycle: IndexLifecycleService
  readonly graphSession: SemanticSearchGraphSource
  readonly logger: LoggerService
}

class SemanticSearchServiceImpl implements SemanticSearchService {
  readonly #deps: SemanticSearchServiceDeps
  readonly #stopFollowingRebuilds: () => void
  readonly #mainWindow: boolean

  constructor(deps: SemanticSearchServiceDeps) {
    this.#deps = deps
    this.#mainWindow = deps.role === 'main'
    const { embeddingRuntime, embeddingIndex, indexLifecycle } = deps
    this.#stopFollowingRebuilds = indexLifecycle.onReconciled(
      async ({ generation, fileGeneration, source }) => {
        if (source !== 'rebuild') {
          return
        }
        const embed = await embeddingRuntime.status()
        if (embed.status === 'ready') {
          await embeddingIndex.backfill({ generation, fileGeneration, modelId: embed.model })
        }
      },
    )
  }

  start(): Unlisten {
    const { embeddingRuntime, embeddingIndex, settings, graphSession, logger } = this.#deps
    if (this.#consumeLegacyOptIn()) {
      settings.update({ semanticSearchEnabled: true })
    }

    let stopped = false
    // What each reaction last ran for: a reaction reruns only when its own
    // inputs change, not on every notification of every source.
    let loadGate: string | null = null
    let followed: string | null = null
    let stopFollowing: Unlisten | null = null

    const react = (): void => {
      if (stopped) {
        return
      }
      const enabled = settings.get().semanticSearchEnabled && this.#mainWindow
      const status = embeddingRuntime.lastStatus()

      const nextLoadGate = `${enabled} ${status.status}`
      if (nextLoadGate !== loadGate) {
        loadGate = nextLoadGate
        if (enabled && status.status === 'uninitialized') {
          void this.ensureModel()
        }
      }

      // embed_apply/embed_remove are gated on the INDEX session generation, not
      // the file-write generation in GraphInfo — the counters are independent.
      const { graph, indexGeneration: generation } = graphSession.getState()
      const target =
        enabled && status.status === 'ready' && generation !== null && graph !== null
          ? {
              generation,
              fileGeneration: graph.generation,
              modelId: status.model,
              root: graph.root,
            }
          : null
      const next = target === null ? null : JSON.stringify(target)
      if (next !== followed) {
        // `enabled` is part of the gate so a mid-session disable tears the
        // follow down: its queued work skips and its subscription drops.
        followed = next
        stopFollowing?.()
        stopFollowing =
          target === null
            ? null
            : embeddingIndex.follow({
                generation: target.generation,
                fileGeneration: target.fileGeneration,
                modelId: target.modelId,
              })
      }
    }

    const unlisteners = [
      settings.subscribe(react),
      embeddingRuntime.subscribe(react),
      graphSession.subscribe(react),
    ]
    // A later start reads the last status the runtime observed; the first one polls.
    embeddingRuntime.status().catch((cause: unknown) => {
      logger.warn('failed to poll the embedding runtime status', cause)
    })
    react()

    return () => {
      stopped = true
      for (const unlisten of unlisteners) {
        unlisten()
      }
      stopFollowing?.()
      stopFollowing = null
    }
  }

  async ensureModel(): Promise<EmbedStatus> {
    const { embeddingRuntime } = this.#deps
    try {
      return await embeddingRuntime.awaitTerminalStatus(await embeddingRuntime.ensure())
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { status: 'failed', message }
    }
  }

  async retryFailedModel(): Promise<void> {
    await this.#deps.embeddingRuntime.retry()
  }

  similarNotes(path: string): Promise<RetrievalHit[]> {
    return this.#deps.retrieval.relatedNotes(path, SIMILAR_NOTES_LIMIT)
  }

  dispose(): void {
    this.#stopFollowingRebuilds()
  }

  /**
   * Read-and-clear the pre-settings localStorage opt-in. Returns true exactly
   * once for a user who enabled semantic search before the flag moved into
   * settings — the caller persists it there and the key never matters again.
   */
  #consumeLegacyOptIn(): boolean {
    const local = this.#deps.storage.local
    const enabled = local.get(LEGACY_ENABLED_KEY) === 'true'
    local.set(LEGACY_ENABLED_KEY, null)
    return enabled
  }
}

export function createSemanticSearchService(
  deps: SemanticSearchServiceDeps,
): SemanticSearchService {
  return new SemanticSearchServiceImpl(deps)
}
