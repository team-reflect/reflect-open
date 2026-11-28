import type { ChunkToEmbed } from '@reflect/types'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { LocalNoteRead, NoteFileService } from '../graph/note-file-service.ts'
import { isNotePath, isTemplatePath } from '../graph/paths.ts'
import { createAssetDescriptionText } from '../indexing/asset-description-text.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { parseNote } from '../markdown/index.ts'
import { chunkAssetDescriptions, chunkNote } from './chunk.ts'
import { noop } from '@ocavue/utils'

/**
 * The incremental embedding pass (Plan 09): chunk a note and send the chunk
 * set as one generation-pinned write. TS owns this orchestration, mirroring
 * the indexing pipeline. Rust (`embed_note_chunks`) keeps the vectors of
 * chunks whose hashes are stored under the runtime's model and embeds the
 * rest.
 *
 * A note's chunk set also carries its referenced assets' description bodies
 * (Plan 20 → semantic leg), mirroring the FTS fold — so a meaning-level query
 * about an image or PDF's contents surfaces the referencing note on the
 * semantic side of hybrid retrieval, not just on keyword matches.
 */

export interface EmbedNoteOptions {
  path: string
  /**
   * The index generation the chunk write carries.
   */
  generation: number
  /**
   * The file generation the note and asset description reads carry.
   */
  fileGeneration: number
  /**
   * Pre-loaded content (the watcher path has it); read from disk if absent.
   */
  content?: string
}

/**

 * How a backfill ended: every note visited, stopped by `signal`, or the note list unreadable.

 */
export type EmbeddingBackfillResult = 'completed' | 'aborted' | 'failed'

export interface EmbeddingBackfillOptions {
  generation: number
  fileGeneration: number
  modelId: string
  onProgress?: (done: number, total: number) => void
  /**
   * Abort between notes (e.g. graph switch).
   */
  signal?: AbortSignal
}

/**

 * Keeps each note's chunk vectors current (Plan 09).

 */
export interface EmbeddingIndexService {
  /**
   * Bring one note's embeddings up to date. Returns the number of chunks that
   * were (re)embedded — 0 means the hash-skip caught everything.
   */
  embedNote(options: EmbedNoteOptions): Promise<number>
  /**
   * Drop a deleted note's chunks + vectors (generation-pinned).
   */
  removeNote(path: string, generation: number): Promise<void>
  /**
   * Backfill every indexed note (initial enable, repair). Serialized; the
   * hash-skip makes re-runs cheap. Reports per-note progress. One note's
   * failure is logged and the pass goes on; the pass never rejects.
   */
  backfill(options: EmbeddingBackfillOptions): Promise<EmbeddingBackfillResult>
  /**
   * Keep the index at `generation` embedded with `modelId`, reading files at
   * `fileGeneration`, until the returned function is called: one backfill, then every applied index batch (changed
   * notes re-embed, removed notes drop their vectors). The work runs on one
   * serial queue that outlives each call, so passes never interleave; work
   * still queued when the follow stops is skipped.
   *
   * The trigger is the post-apply signal, not the raw watcher stream.
   * Ordering: `embed_note_chunks` drops chunks for paths without a `notes` row, so
   * embedding a brand-new note off the raw file event could race its index
   * apply and lose the chunks until the next backfill; post-apply, the row is
   * always there. Coverage: asset description writes re-index their
   * referencing notes *outside* the watcher pipeline and emit the same
   * signal, and those notes must re-embed for the description text to reach
   * semantic search.
   */
  follow(options: { generation: number; fileGeneration: number; modelId: string }): Unlisten
}

export interface EmbeddingIndexServiceDeps {
  readonly ipc: IpcBridgeService
  readonly noteFile: NoteFileService
  readonly database: DatabaseService
  readonly indexLifecycle: IndexLifecycleService
  readonly logger: LoggerService
  readonly clock: ClockService
}

/**
 * What one backfill pass did, for its summary log line.
 */
interface BackfillCounts {
  notes: number
  done: number
  notesEmbedded: number
  chunksEmbedded: number
  failed: number
}

class EmbeddingIndexServiceImpl implements EmbeddingIndexService {
  readonly #deps: EmbeddingIndexServiceDeps
  readonly #assetDescriptionText: ReturnType<typeof createAssetDescriptionText>
  #queue: Promise<void> = Promise.resolve()

  constructor(deps: EmbeddingIndexServiceDeps) {
    this.#deps = deps
    this.#assetDescriptionText = createAssetDescriptionText({ noteFile: deps.noteFile })
  }

  async embedNote(options: EmbedNoteOptions): Promise<number> {
    const { noteFile } = this.#deps
    const { path, generation, fileGeneration } = options
    if (isTemplatePath(path)) {
      return 0 // templates are boilerplate — never embedded, never retrieved
    }
    let content = options.content
    if (content === undefined) {
      let read: LocalNoteRead
      try {
        read = await noteFile.readLocal(path, fileGeneration)
      } catch {
        return 0 // deleted between event and read; the remove path handles it
      }
      if (read.kind === 'evicted') {
        // iCloud-evicted: reading would force an on-demand download, and the
        // backfill sweeping a whole evicted graph would turn into thousands of
        // serial blocking downloads. The pre-eviction vectors stay valid (rows
        // survive eviction); if the note re-materializes with new content, the
        // index-applied follow-up re-embeds it then.
        return 0
      }
      content = read.content
    }

    const parsed = parseNote({ path, source: content })
    const gathered = await this.#assetDescriptionText.gatherBodies(
      parsed.assets.map((asset) => asset.path),
      fileGeneration,
    )
    if (gathered.evicted.length > 0) {
      // A referenced sidecar is iCloud-evicted. `embed_note_chunks` replaces the
      // note's *entire* chunk set, so applying without that sidecar's body
      // would silently drop its previously embedded chunks — and sidecars are
      // untracked by the watcher, so nothing would ever restore them. Skip the
      // whole note this pass; the stored vectors stay valid until the sidecar
      // is local again.
      return 0
    }
    const chunks = [
      ...(await chunkNote(path, content, parsed)),
      ...(await chunkAssetDescriptions(gathered.bodies, content.length + 1)),
    ]
    const payload: ChunkToEmbed[] = chunks.map((chunk) => ({
      heading: chunk.heading,
      posFrom: chunk.posFrom,
      posTo: chunk.posTo,
      text: chunk.text,
      contentHash: chunk.contentHash,
    }))
    // An empty set drops the note's chunks.
    return await this.#deps.ipc.call('embed_note_chunks', { path, chunks: payload, generation })
  }

  async removeNote(path: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('embed_note_chunks', { path, chunks: [], generation })
  }

  backfill(options: EmbeddingBackfillOptions): Promise<EmbeddingBackfillResult> {
    const pass = this.#queue.then(() => this.#runBackfill(options))
    this.#queue = pass.then(noop)
    return pass
  }

  follow(options: { generation: number; fileGeneration: number; modelId: string }): Unlisten {
    const { indexLifecycle, logger } = this.#deps
    const { generation, fileGeneration, modelId } = options
    const stopped = new AbortController()

    this.#queue = this.#queue
      .then(() => {
        if (stopped.signal.aborted) {
          return
        }
        return this.#runBackfill({
          generation,
          fileGeneration,
          modelId,
          signal: stopped.signal,
        }).then(noop)
      })
      .catch((cause: unknown) => {
        // A rejection here must not poison the queue (later change items
        // chain off this promise) nor masquerade as a per-change failure.
        logger.error('embedding backfill failed:', cause)
      })

    const unlisten = indexLifecycle.onApplied((event) => {
      if (stopped.signal.aborted || event.generation !== generation || event.changes === null) {
        return // torn down, a delayed emit from a superseded index session, or a sync pass
      }
      for (const change of event.changes) {
        if (!isNotePath(change.path)) {
          continue // asset-file changes ride the same batches — never embedded
        }
        this.#queue = this.#queue
          .then(() => {
            if (stopped.signal.aborted) {
              return
            }
            return change.kind === 'remove'
              ? this.removeNote(change.path, generation)
              : this.embedNote({ path: change.path, generation, fileGeneration }).then(noop)
          })
          .catch((cause: unknown) => {
            logger.error(`embedding sync failed for ${change.path}:`, cause)
          })
      }
    })

    return () => {
      stopped.abort()
      unlisten()
    }
  }

  /**
   * One backfill pass. Callers run it on `#queue`.
   */
  async #runBackfill(options: EmbeddingBackfillOptions): Promise<EmbeddingBackfillResult> {
    const { clock, logger } = this.#deps
    const started = clock.monotonicNow()
    const counts: BackfillCounts = {
      notes: 0,
      done: 0,
      notesEmbedded: 0,
      chunksEmbedded: 0,
      failed: 0,
    }
    let outcome: EmbeddingBackfillResult
    try {
      outcome = await this.#backfillNotes(options, counts)
    } catch {
      outcome = 'failed'
    }
    logger.info('embedding backfill finished', {
      outcome,
      modelId: options.modelId,
      generation: options.generation,
      ...counts,
      elapsedMs: clock.monotonicNow() - started,
    })
    return outcome
  }

  async #backfillNotes(
    options: EmbeddingBackfillOptions,
    counts: BackfillCounts,
  ): Promise<'completed' | 'aborted'> {
    const { clock, database, logger } = this.#deps
    const { generation, fileGeneration, onProgress, signal } = options
    const paths = await database.read('index_embeddable_paths', {})
    counts.notes = paths.length
    for (const path of paths) {
      if (signal?.aborted === true) {
        return 'aborted'
      }
      try {
        const started = clock.monotonicNow()
        const chunks = await this.embedNote({ path, generation, fileGeneration })
        if (chunks > 0) {
          counts.notesEmbedded += 1
          counts.chunksEmbedded += chunks
          // The backfill is background work: rest as long as the note took,
          // so the embedding runtime is busy at most half the time.
          const elapsed = clock.monotonicNow() - started
          if (elapsed > 0) {
            await clock.sleep(elapsed)
          }
        }
      } catch (cause) {
        counts.failed += 1
        logger.error(`embedding backfill failed for ${path}:`, cause)
      }
      counts.done += 1
      onProgress?.(counts.done, paths.length)
    }
    return 'completed'
  }
}

export function createEmbeddingIndexService(
  deps: EmbeddingIndexServiceDeps,
): EmbeddingIndexService {
  return new EmbeddingIndexServiceImpl(deps)
}
