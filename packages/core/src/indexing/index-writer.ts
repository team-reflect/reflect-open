import type { NoteRead } from '@reflect/types'
import { noop, returnFalse } from '@ocavue/utils'
import type { MaybePromise } from '@reflect/utils'
import type { XArchiveService } from '../embeds/x-archive-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { isNotePath } from '../graph/paths.ts'
import { parseNote } from '../markdown/index.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { createAssetDescriptionText, type AssetDescriptionText } from './asset-description-text.ts'
import type { DatabaseService } from './database-service.ts'
import type { DirtyEntry, DirtySet } from './dirty-set.ts'
import type { FileChange } from './file-change-service.ts'
import { matchesTrustedMtime } from './hash.ts'
import type { IndexedFileFacts, IndexQueryService } from './index-query-service.ts'
import {
  INDEX_APPLY_BATCH_SIZE,
  type IndexCommit,
  type WritableIndexStoreService,
} from './index-store-service.ts'
import { buildIndexedNote, type IndexedNote } from './indexed-note.ts'
import { createMoveHealing, type MoveHealing } from './move-healing.ts'
import { INDEX_PASS_YIELD_EVERY, yieldToEventLoop } from './pacing.ts'

/**
 * The services the indexing components read from and write through.
 */
export interface IndexingDeps {
  readonly indexStore: WritableIndexStoreService
  readonly noteFile: NoteFileService
  readonly indexQuery: IndexQueryService
  readonly database: DatabaseService
  readonly xArchive: XArchiveService
  readonly clock: ClockService
  readonly logger: LoggerService
}

/**
 * Reports file changes after the index applied them at `generation`.
 */
export type ChangesAppliedEmitter = (changes: readonly FileChange[], generation: number) => void

/**
 * What the writer did for one dirty path.
 *
 * - `applied`: a commit wrote the path's rows (apply, remove, move, or mtime
 *   re-stamp). `seq` is that commit's seq, `null` for a stale generation.
 * - `unchanged`: the rows already matched the file.
 * - `failed`: the file read (`read`) or the index write (`write`) failed. The
 *   path is no longer dirty.
 * - `deferred`: the writer is paused or disposed. The path stays dirty.
 */
export type IndexWriteOutcome =
  | { readonly status: 'applied'; readonly seq: number | null }
  | { readonly status: 'unchanged' }
  | { readonly status: 'failed'; readonly stage: 'read' | 'write'; readonly error: unknown }
  | { readonly status: 'deferred' }

export interface IndexWriterDeps extends IndexingDeps {
  /**
   * Receives the paths each run settled, except `bulk` ones, after their rows are written.
   */
  readonly emitChangesApplied: ChangesAppliedEmitter
  /**
   * Receives each external rename the writer healed by moving the rows.
   */
  readonly emitMoved: (from: string, to: string) => void
  /**
   * Whether index writes may run now. The writer asks before every write.
   */
  readonly canWrite: () => boolean
}

/**
 * What identifies the index session a writer writes to.
 */
export interface IndexWriterOptions {
  readonly dirty: DirtySet
  /**
   * The index generation every write carries.
   */
  readonly generation: number
  /**
   * The file generation every read carries.
   */
  readonly fileGeneration: number
}

/**
 * The one writer of the index projection. It applies the dirty set in serial
 * runs: each run takes every dirty path, reads the files then (unless a hint
 * carries the content), and writes the rows that differ. The file decides
 * whether a note is removed: a `remove` hint for a file that exists is an upsert.
 */
export interface IndexWriter {
  readonly dirty: DirtySet
  readonly generation: number
  readonly fileGeneration: number
  /**
   * Resolve with the outcome of `path` once the run that covers its current
   * dirty entry settles it. For a path the run reports, that is after the
   * report. A path that is neither dirty nor in a run resolves `unchanged`
   * at once.
   */
  settled(path: string): Promise<IndexWriteOutcome>
  /**
   * Like {@link IndexWriter.settled}, and the run in flight writes and
   * reports `path` before its remaining paths.
   */
  settledFirst(path: string): Promise<IndexWriteOutcome>
  /**
   * The seq of this writer's latest commit, `null` before its first.
   */
  seq(): number | null
  /**
   * Resolve once no run is queued or in flight: every dirty path is settled,
   * or the writer is paused.
   */
  drained(): Promise<void>
  /**
   * Wipe the derived tables, in order with the runs.
   */
  clear(): Promise<IndexCommit>
  /**
   * Stop writing. The run in flight stops before its next write. Paths stay dirty.
   */
  pause(): void
  /**
   * Write again after {@link IndexWriter.pause}, or after `canWrite` turned true.
   */
  resume(): void
  /**
   * Stop for good and release every waiter.
   */
  dispose(): void
}

interface WriterRun {
  /**
   * The taken entries the run has not settled, by path.
   */
  readonly open: Map<string, DirtyEntry>
  readonly waiters: Map<string, PromiseWithResolvers<IndexWriteOutcome>>
  /**
   * The settled changes to report.
   */
  readonly reported: FileChange[]
  /**
   * Releases the waiters of the reported changes.
   */
  readonly afterReport: Array<() => void>
  /**
   * The notes read while pairing moves, by path.
   */
  notes: Map<string, NoteRead>
}

interface PendingApply {
  readonly entry: DirtyEntry
  readonly projection: IndexedNote
}

interface PendingTouch {
  readonly entry: DirtyEntry
  readonly mtime: number
}

function toFileChange(entry: DirtyEntry): FileChange {
  return entry.modifiedMs === undefined
    ? { path: entry.path, kind: entry.kind }
    : { path: entry.path, kind: entry.kind, modifiedMs: entry.modifiedMs }
}

class IndexWriterImpl implements IndexWriter {
  readonly #deps: IndexWriterDeps
  readonly dirty: DirtySet
  readonly generation: number
  readonly fileGeneration: number
  readonly #assetText: AssetDescriptionText
  readonly #moveHealing: MoveHealing
  readonly #stopListening: () => void
  readonly #waiters = new Map<string, PromiseWithResolvers<IndexWriteOutcome>>()
  readonly #runs = new Set<WriterRun>()
  readonly #first = new Set<string>()
  #tail: Promise<void> = Promise.resolve()
  #seq: number | null = null
  #runQueued = false
  #paused = false
  #disposed = false

  constructor(deps: IndexWriterDeps, options: IndexWriterOptions) {
    this.#deps = deps
    this.dirty = options.dirty
    this.generation = options.generation
    this.fileGeneration = options.fileGeneration
    this.#assetText = createAssetDescriptionText(deps)
    this.#moveHealing = createMoveHealing(deps)
    this.#stopListening = this.dirty.subscribe(() => {
      this.#wake()
    })
    this.#wake()
  }

  settled(path: string): Promise<IndexWriteOutcome> {
    if (this.dirty.has(path)) {
      if (this.#isStopped()) {
        return Promise.resolve({ status: 'deferred' })
      }
      this.#wake()
      return this.#waiterIn(this.#waiters, path).promise
    }
    for (const run of this.#runs) {
      if (run.open.has(path)) {
        return this.#waiterIn(run.waiters, path).promise
      }
    }
    return Promise.resolve({ status: 'unchanged' })
  }

  settledFirst(path: string): Promise<IndexWriteOutcome> {
    const settled = this.settled(path)
    if (this.#runQueued || this.#runs.size > 0) {
      this.#first.add(path)
    }
    return settled
  }

  seq(): number | null {
    return this.#seq
  }

  async drained(): Promise<void> {
    let tail: Promise<void>
    do {
      tail = this.#tail
      await tail
    } while (tail !== this.#tail)
  }

  clear(): Promise<IndexCommit> {
    const commit = this.#tail.then(() => this.#commit(this.#deps.indexStore.clear(this.generation)))
    this.#tail = commit.then(noop, noop)
    return commit
  }

  pause(): void {
    this.#paused = true
    this.#deferWaiters()
  }

  resume(): void {
    this.#paused = false
    this.#wake()
  }

  dispose(): void {
    this.#disposed = true
    this.#stopListening()
    this.#deferWaiters()
  }

  #isStopped(): boolean {
    return this.#disposed || this.#paused || !this.#deps.canWrite()
  }

  #waiterIn(
    waiters: Map<string, PromiseWithResolvers<IndexWriteOutcome>>,
    path: string,
  ): PromiseWithResolvers<IndexWriteOutcome> {
    let waiter = waiters.get(path)
    if (waiter === undefined) {
      waiter = Promise.withResolvers<IndexWriteOutcome>()
      waiters.set(path, waiter)
    }
    return waiter
  }

  #deferWaiters(): void {
    for (const waiter of this.#waiters.values()) {
      waiter.resolve({ status: 'deferred' })
    }
    this.#waiters.clear()
  }

  /**
   * Queue a run when there is dirty work and none is queued.
   */
  #wake(): void {
    if (this.#runQueued || this.dirty.size() === 0) {
      return
    }
    if (this.#isStopped()) {
      this.#deferWaiters()
      return
    }
    this.#runQueued = true
    this.#tail = this.#tail.then(() => this.#runOnce())
  }

  async #runOnce(): Promise<void> {
    this.#runQueued = false
    if (this.#isStopped()) {
      this.#deferWaiters()
      return
    }
    await this.#settleEntries(this.dirty.take())
    this.#wake()
  }

  /**
   * Write `entries` as one run, report it, and put back what it did not settle.
   */
  async #settleEntries(entries: readonly DirtyEntry[]): Promise<void> {
    const run: WriterRun = {
      open: new Map(entries.map((entry) => [entry.path, entry])),
      waiters: new Map(),
      reported: [],
      afterReport: [],
      notes: new Map(),
    }
    for (const entry of entries) {
      const waiter = this.#waiters.get(entry.path)
      if (waiter !== undefined) {
        run.waiters.set(entry.path, waiter)
        this.#waiters.delete(entry.path)
      }
    }
    this.#runs.add(run)
    try {
      await this.#write(run, entries)
    } catch (error) {
      this.#deps.logger.error('index writer run failed:', error)
      for (const entry of run.open.values()) {
        this.#settle(run, entry, { status: 'failed', stage: 'write', error })
      }
    }
    this.#runs.delete(run)
    const unwritten = [...run.open.values()]
    this.dirty.restore(unwritten)
    for (const entry of unwritten) {
      run.waiters.get(entry.path)?.resolve({ status: 'deferred' })
    }
    if (run.reported.length > 0 && !this.#disposed) {
      this.#deps.emitChangesApplied(run.reported, this.generation)
    }
    for (const release of run.afterReport) {
      release()
    }
  }

  /**
   * Write the paths of {@link IndexWriter.settledFirst} as a run of their own, inside `run`.
   */
  async #writeFirst(
    run: WriterRun,
    applies: PendingApply[],
    touches: PendingTouch[],
  ): Promise<void> {
    await this.#flushApplies(run, applies)
    await this.#flushTouches(run, touches.splice(0))
    const entries: DirtyEntry[] = []
    for (const path of this.#first) {
      const taken = run.open.get(path)
      if (taken !== undefined) {
        run.open.delete(path)
        this.dirty.restore([taken])
        const waiter = run.waiters.get(path)
        if (waiter !== undefined) {
          run.waiters.delete(path)
          void this.#waiterIn(this.#waiters, path).promise.then((outcome) => {
            waiter.resolve(outcome)
          })
        }
      }
      const entry = this.dirty.takePath(path)
      if (entry !== undefined) {
        entries.push(entry)
      }
    }
    this.#first.clear()
    await this.#settleEntries(entries)
  }

  /**
   * Settle every entry of the run, or return early once the writer stops.
   */
  async #write(run: WriterRun, entries: readonly DirtyEntry[]): Promise<void> {
    const { indexStore, noteFile, clock } = this.#deps
    const notes = await this.#checkRemoves(
      run,
      entries.filter((entry) => isNotePath(entry.path)),
    )
    await this.#healMoves(run, notes)
    if (this.#isStopped()) {
      return
    }
    const facts = await this.#prefetchFacts(
      notes.filter((entry) => entry.kind === 'upsert').map((entry) => entry.path),
    )
    const now = clock.now()
    const applies: PendingApply[] = []
    const touches: PendingTouch[] = []
    let done = 0
    for (const { path } of notes) {
      const entry = run.open.get(path)
      if (entry === undefined) {
        continue
      }
      done += 1
      if (done % INDEX_PASS_YIELD_EVERY === 0) {
        await yieldToEventLoop()
      }
      if (this.#isStopped()) {
        return
      }
      if (this.#first.size > 0) {
        await this.#writeFirst(run, applies, touches)
        if (this.#isStopped()) {
          return
        }
        if (!run.open.has(path)) {
          continue
        }
      }
      if (entry.kind === 'remove') {
        // An upsert queued earlier in this run must not land after the remove.
        await this.#flushApplies(run, applies)
        if (this.#isStopped()) {
          return
        }
        try {
          const { seq } = await this.#commit(indexStore.remove(path, this.generation))
          this.#settle(run, entry, { status: 'applied', seq })
        } catch (error) {
          this.#settle(run, entry, { status: 'failed', stage: 'write', error })
        }
        continue
      }
      const stored = facts.get(path)
      const known = entry.note ?? run.notes.get(path)
      if (
        known === undefined &&
        !entry.force &&
        matchesTrustedMtime(stored?.mtime, entry.modifiedMs, now)
      ) {
        this.#settle(run, entry, { status: 'unchanged' })
        continue
      }
      let projection: IndexedNote
      try {
        const { content, hash: fileHash } =
          known ?? (await noteFile.readWithHash(path, this.fileGeneration))
        if (!entry.force && stored?.fileHash === fileHash) {
          if (entry.modifiedMs !== undefined && stored.mtime !== entry.modifiedMs) {
            touches.push({ entry, mtime: entry.modifiedMs })
          } else {
            this.#settle(run, entry, { status: 'unchanged' })
          }
          continue
        }
        projection = await this.#buildNoteProjection(path, content, {
          fileHash,
          mtime: entry.modifiedMs ?? clock.now(),
        })
      } catch (error) {
        this.#settle(run, entry, { status: 'failed', stage: 'read', error })
        continue
      }
      applies.push({ entry, projection })
      if (applies.length >= INDEX_APPLY_BATCH_SIZE) {
        if (this.#isStopped()) {
          return
        }
        await this.#flushApplies(run, applies)
      }
    }
    if (this.#isStopped()) {
      return
    }
    await this.#flushApplies(run, applies)
    if (this.#isStopped()) {
      return
    }
    await this.#flushTouches(run, touches)
    // Paths the index holds no rows for (asset files) settle after the notes,
    // so a reader of the report sees the notes of the same run.
    for (const entry of run.open.values()) {
      this.#settle(run, entry, { status: 'unchanged' })
    }
  }

  /**
   * Turn each remove of a note whose file exists into an upsert.
   */
  async #checkRemoves(run: WriterRun, notes: readonly DirtyEntry[]): Promise<DirtyEntry[]> {
    const { noteFile } = this.#deps
    return await Promise.all(
      notes.map(async (entry) => {
        if (entry.kind !== 'remove' || !(await noteFile.exists(entry.path).catch(returnFalse))) {
          return entry
        }
        const upsert: DirtyEntry = { ...entry, kind: 'upsert' }
        run.open.set(entry.path, upsert)
        return upsert
      }),
    )
  }

  /**
   * Heal external renames: a removed path whose rows carry the frontmatter id
   * of an upserted path without rows. The rows move, and the destination is
   * then written again in the same run.
   */
  async #healMoves(run: WriterRun, notes: readonly DirtyEntry[]): Promise<void> {
    const { indexStore, indexQuery, logger } = this.#deps
    const removes = notes.filter((entry) => entry.kind === 'remove')
    const upserts = notes.filter((entry) => entry.kind === 'upsert')
    if (removes.length === 0 || upserts.length === 0) {
      return
    }
    try {
      const indexed = await indexQuery.getNoteIdsByPath(upserts.map((entry) => entry.path))
      const arrivals = upserts.filter((entry) => !indexed.has(entry.path))
      const { moves, notes: read } = await this.#moveHealing.detectExternalMoves(
        removes.map((entry) => entry.path),
        arrivals.map((entry) => entry.path),
        this.fileGeneration,
      )
      run.notes = read
      for (const move of moves) {
        const from = run.open.get(move.from)
        const to = run.open.get(move.to)
        if (this.#isStopped() || from === undefined || to === undefined) {
          return
        }
        try {
          const { seq } = await this.#commit(indexStore.move(move.from, move.to, this.generation))
          this.#settle(run, from, { status: 'applied', seq })
          run.open.set(move.to, { ...to, force: true })
          this.#deps.emitMoved(move.from, move.to)
        } catch (error) {
          logger.error(`id-based move failed (${move.from} → ${move.to}):`, error)
        }
      }
    } catch (error) {
      logger.error('move healing failed; applying the changes plainly:', error)
    }
  }

  /**
   * The stored facts of `paths`. On failure every path takes the read-and-hash path.
   */
  async #prefetchFacts(paths: string[]): Promise<Map<string, IndexedFileFacts>> {
    const { indexQuery, logger } = this.#deps
    if (paths.length === 0) {
      return new Map()
    }
    try {
      return await indexQuery.getIndexedFileFactsByPath(paths)
    } catch (error) {
      logger.error('stored-facts prefetch failed; writing without skips:', error)
      return new Map()
    }
  }

  async #buildNoteProjection(
    path: string,
    content: string,
    facts: { fileHash: string; mtime: number },
  ): Promise<IndexedNote> {
    const parsed = parseNote({ path, source: content })
    const text = await this.#assetText.gatherText(
      parsed.assets.map((asset) => asset.path),
      this.fileGeneration,
    )
    return buildIndexedNote(parsed, {
      fileHash: facts.fileHash,
      mtime: facts.mtime,
      source: content,
      assetText: text,
    })
  }

  async #flushApplies(run: WriterRun, applies: PendingApply[]): Promise<void> {
    await this.#applySplit(run, applies.splice(0))
  }

  /**
   * Apply `applies` in one transaction. A refused batch splits in half until
   * the failing note stands alone.
   */
  async #applySplit(run: WriterRun, applies: readonly PendingApply[]): Promise<void> {
    if (applies.length === 0) {
      return
    }
    try {
      const { seq } = await this.#commit(
        this.#deps.indexStore.applyBatch(
          applies.map((apply) => apply.projection),
          this.generation,
        ),
      )
      for (const { entry } of applies) {
        this.#settle(run, entry, { status: 'applied', seq })
      }
    } catch (error) {
      if (applies.length === 1) {
        this.#settle(run, applies[0]!.entry, { status: 'failed', stage: 'write', error })
        return
      }
      const midpoint = Math.ceil(applies.length / 2)
      await this.#applySplit(run, applies.slice(0, midpoint))
      await this.#applySplit(run, applies.slice(midpoint))
    }
  }

  async #flushTouches(run: WriterRun, touches: readonly PendingTouch[]): Promise<void> {
    for (let start = 0; start < touches.length; start += INDEX_APPLY_BATCH_SIZE) {
      const batch = touches.slice(start, start + INDEX_APPLY_BATCH_SIZE)
      try {
        const { seq } = await this.#commit(
          this.#deps.indexStore.touch(
            batch.map(({ entry, mtime }) => ({ path: entry.path, mtime })),
            this.generation,
          ),
        )
        for (const { entry } of batch) {
          this.#settle(run, entry, { status: 'applied', seq })
        }
      } catch (error) {
        for (const { entry } of batch) {
          this.#settle(run, entry, { status: 'failed', stage: 'write', error })
        }
      }
    }
  }

  /**
   * Await an index write and remember its seq.
   */
  async #commit(write: MaybePromise<IndexCommit>): Promise<IndexCommit> {
    const commit = await write
    this.#seq = commit.seq ?? this.#seq
    return commit
  }

  /**
   * Record the outcome of `entry`. A failure nobody waits for is logged.
   */
  #settle(run: WriterRun, entry: DirtyEntry, outcome: IndexWriteOutcome): void {
    run.open.delete(entry.path)
    const waiter = run.waiters.get(entry.path)
    run.waiters.delete(entry.path)
    if (outcome.status === 'failed') {
      if (waiter === undefined) {
        this.#deps.logger.error(`failed to index change for ${entry.path}:`, outcome.error)
      }
      waiter?.resolve(outcome)
      return
    }
    if (entry.bulk) {
      waiter?.resolve(outcome)
      return
    }
    run.reported.push(toFileChange(entry))
    if (waiter !== undefined) {
      run.afterReport.push(() => {
        waiter.resolve(outcome)
      })
    }
  }
}

/**
 * Create the {@link IndexWriter} of one index session. It starts writing at once.
 */
export function createIndexWriter(deps: IndexWriterDeps, options: IndexWriterOptions): IndexWriter {
  return new IndexWriterImpl(deps, options)
}
