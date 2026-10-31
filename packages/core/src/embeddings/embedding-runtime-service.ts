import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'

/**

 * Byte counts for an active model download; absent until it starts.

 */
export const embedProgressSchema = z.object({
  /**
   * Bytes fetched so far.
   */
  downloaded: z.number().int().nonnegative(),
  /**
   * Bytes the download will fetch in total.
   */
  total: z.number().int().nonnegative(),
})
export type EmbedProgress = z.infer<typeof embedProgressSchema>

export const embedStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('uninitialized') }),
  z.object({
    status: z.literal('loading'),
    progress: embedProgressSchema.optional(),
  }),
  z.object({ status: z.literal('ready'), model: z.string() }),
  z.object({ status: z.literal('failed'), message: z.string() }),
  z.object({ status: z.literal('unsupported') }),
])
export type EmbedStatus = z.infer<typeof embedStatusSchema>

const vectorsSchema = z.array(z.array(z.number()))

/**
 * The local embedding model (Plan 09): download, load, status, and text
 * vectors. Platforms without a runtime answer `unsupported`.
 */
export interface EmbeddingRuntimeService {
  /**
   * Poll the runtime status.
   */
  status(): Promise<EmbedStatus>
  /**
   * Load (downloading on first use) the model. Resolves with the outcome, or
   * with `loading` when another caller's load is in flight.
   */
  ensure(): Promise<EmbedStatus>
  /**
   * Resolve once the runtime leaves `uninitialized` / `loading`, starting
   * from `initial` (usually what {@link ensure} returned).
   */
  awaitTerminalStatus(initial: EmbedStatus): Promise<EmbedStatus>
  /**
   * Re-load a `failed` model and resolve with the outcome; any other status
   * resolves as is. A reload that throws resolves as `failed`.
   */
  retry(): Promise<EmbedStatus>
  /**
   * Embed `texts` into 384-dim vectors. Rejects unless the status is `ready`.
   */
  embedTexts(texts: readonly string[]): Promise<number[][]>
  /**
   * Call `listener` with every status this service observes (events and polls).
   */
  subscribe(listener: (status: EmbedStatus) => void): Unlisten
  /**
   * The last observed status; `uninitialized` before the first one.
   */
  lastStatus(): EmbedStatus
}

const STATUS_EVENT = 'embed:status'

const UNINITIALIZED: EmbedStatus = { status: 'uninitialized' }

function isTerminalStatus(status: EmbedStatus): boolean {
  return status.status !== 'uninitialized' && status.status !== 'loading'
}

function failedStatus(cause: unknown): EmbedStatus {
  return { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
}

interface StatusEvents {
  /**
   * Settles once the native listener is registered (or failed to register).
   */
  registered: Promise<void>
  stop: Unlisten
}

export interface EmbeddingRuntimeServiceDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

class EmbeddingRuntimeServiceImpl implements EmbeddingRuntimeService {
  readonly #deps: EmbeddingRuntimeServiceDeps
  readonly #listeners = new Set<(status: EmbedStatus) => void>()
  #last = UNINITIALIZED
  #events: StatusEvents | null = null

  constructor(deps: EmbeddingRuntimeServiceDeps) {
    this.#deps = deps
  }

  async status(): Promise<EmbedStatus> {
    return this.#observe(await this.#deps.ipc.call('embed_status', {}, embedStatusSchema))
  }

  async ensure(): Promise<EmbedStatus> {
    return this.#observe(await this.#deps.ipc.call('embed_ensure', {}, embedStatusSchema))
  }

  async awaitTerminalStatus(initial: EmbedStatus): Promise<EmbedStatus> {
    const { logger } = this.#deps
    if (isTerminalStatus(initial)) {
      return initial
    }
    return await new Promise((resolve) => {
      const unsubscribe = this.subscribe((next) => {
        if (isTerminalStatus(next)) {
          unsubscribe()
          resolve(next)
        }
      })
      // The terminal event may have fired before the listener registered.
      void (this.#events?.registered ?? Promise.resolve()).then(async () => {
        try {
          await this.status()
        } catch (cause) {
          logger.warn('failed to poll the embedding runtime status', cause)
        }
      })
    })
  }

  async retry(): Promise<EmbedStatus> {
    const current = await this.status()
    if (current.status !== 'failed') {
      return current
    }
    try {
      return await this.awaitTerminalStatus(await this.ensure())
    } catch (cause) {
      return failedStatus(cause)
    }
  }

  embedTexts(texts: readonly string[]): Promise<number[][]> {
    return this.#deps.ipc.call('embed_texts', { texts: [...texts] }, vectorsSchema)
  }

  subscribe(listener: (status: EmbedStatus) => void): Unlisten {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (status: EmbedStatus): void => {
      listener(status)
    }
    this.#listeners.add(deliver)
    this.#events ??= this.#startEvents()
    let attached = true
    return () => {
      if (!attached) {
        return
      }
      attached = false
      this.#listeners.delete(deliver)
      if (this.#listeners.size === 0) {
        this.#events?.stop()
        this.#events = null
      }
    }
  }

  lastStatus(): EmbedStatus {
    return this.#last
  }

  #observe(status: EmbedStatus): EmbedStatus {
    this.#last = status
    for (const listener of this.#listeners) {
      listener(status)
    }
    return status
  }

  #onEvent(payload: unknown): void {
    const parsed = embedStatusSchema.safeParse(payload)
    if (parsed.success) {
      this.#observe(parsed.data)
    } else {
      this.#deps.logger.error(`invalid ${STATUS_EVENT} payload:`, parsed.error)
    }
  }

  // One native listener shared by every subscriber while any is attached.
  #startEvents(): StatusEvents {
    const { ipc, logger } = this.#deps
    let stopped = false
    let unlisten: Unlisten | null = null
    const registered = (async () => {
      try {
        const registration = await ipc.listen(STATUS_EVENT, (payload) => {
          this.#onEvent(payload)
        })
        if (stopped) {
          registration()
        } else {
          unlisten = registration
        }
      } catch (cause) {
        if (!stopped) {
          logger.warn(`failed to listen for "${STATUS_EVENT}"`, cause)
        }
      }
    })()
    return {
      registered,
      stop: () => {
        stopped = true
        unlisten?.()
        unlisten = null
      },
    }
  }
}

export function createEmbeddingRuntimeService(
  deps: EmbeddingRuntimeServiceDeps,
): EmbeddingRuntimeService {
  return new EmbeddingRuntimeServiceImpl(deps)
}
