import type { ClockService } from '../ports/clock-service.ts'
import { sha256Hex } from '@reflect/utils'
import type { LoggerService } from '../ports/logger-service.ts'
import { isAppError } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { parseNote } from '../markdown/index.ts'
import type { XArchiveService } from '../embeds/x-archive-service.ts'
import { createAssetDescriptionText, type AssetDescriptionText } from './asset-description-text.ts'
import { createAssetReferences, type AssetReferences } from './asset-refs.ts'
import type { DatabaseService } from './database-service.ts'
import type { FileChange } from './file-change-service.ts'
import type { IndexQueryService } from './index-query-service.ts'
import type { IndexStoreService, SkippedIndexedNote } from './index-store-service.ts'
import { buildIndexedNote, PROJECTION_VERSION, type IndexedNote } from './indexed-note.ts'
import { createMoveHealing, type MoveHealing } from './move-healing.ts'
import { INDEX_PASS_YIELD_EVERY, yieldToEventLoop } from './pacing.ts'

/**
 * The indexing pipeline (Plan 04): read (Plan 02) → parse/extract in TS
 * (Plan 03) → hash → hand the flattened projection to Rust, which applies it in
 * one transaction. The index is a rebuildable cache.
 *
 * Every write carries the index `generation` returned by `IndexStoreService.open`, and
 * every file read carries the file `fileGeneration` from `graph_open`. Rust
 * no-ops a write whose generation is stale, so a pass started for one graph can
 * never mutate a newly-opened index — cancellation is correct regardless of
 * caller timing (the watcher in Plan 04b indexes outside the serialized open
 * flow). The `AbortSignal` is an optimization that stops a superseded pass early.
 */

/**
 * The `index_meta` key holding the {@link PROJECTION_VERSION} the stored rows
 * were built with. Stamped after every full rebuild; `index_clear` preserves
 * `index_meta`, and the stamp is rewritten once the rebuild completes.
 */
export const PROJECTION_VERSION_KEY = 'projection_version'

/**
 * The services the indexing components read from and write through.
 */
export interface IndexingDeps {
  readonly indexStore: IndexStoreService
  readonly noteFile: NoteFileService
  readonly indexQuery: IndexQueryService
  readonly database: DatabaseService
  readonly xArchive: XArchiveService
  readonly clock: ClockService
  readonly logger: LoggerService
}

/**
 * Reports a batch of file changes after the index applied it at `generation`.
 * The lifecycle that owns the indexer supplies it and forwards each batch to
 * its `onApplied` listeners.
 */
export type ChangesAppliedEmitter = (changes: readonly FileChange[], generation: number) => void

export interface NoteIndexerDeps extends IndexingDeps {
  readonly emitChangesApplied: ChangesAppliedEmitter
}

/**
 * Options for the long-running index passes.
 */
export interface IndexPassOptions {
  /**
   * The index generation from `IndexStoreService.open`; stale writes are dropped by Rust.
   */
  generation: number
  /**
   * The file generation from `graph_open`; every file read of the pass carries it.
   */
  fileGeneration: number
  /**
   * Aborts the pass early when the active graph changes.
   */
  signal?: AbortSignal
  /**
   * Called when a full rebuild cannot apply one note's projection even after
   * retrying it outside the batch. The rebuild continues so one bad projection
   * cannot leave the whole cache empty after `index_clear`. If omitted, that
   * final single-note failure is thrown.
   */
  onSkippedNote?: (note: SkippedIndexedNote) => void
  /**
   * Called after id-based move healing relocates a note's rows (Plan 17): an
   * external rename observed after the fact. The desktop layer uses it to
   * carry live sessions and rewrite routes, exactly as for an in-app rename
   * — without it, history entries keep pointing at the dead path.
   */
  onMoved?: ((from: string, to: string) => void) | undefined
  /**
   * Called as the pass advances through the file listing — at every pacing
   * break and once at the end — so a first index over thousands of notes can
   * show real progress instead of a frozen shell. `done` counts every listed
   * file the pass has moved past (skipped or indexed); `total` is the listing
   * size; `worked` counts the files actually *read* so far (not skipped
   * read-free by the mtime layer). `worked` is what distinguishes a genuine
   * first index from a routine repeat pass that skips everything — the
   * progress UI must gate on it, or a healthy sub-second pass flashes a
   * "preparing" surface on every open.
   */
  onFileProgress?: (done: number, total: number, worked: number) => void
  /**
   * Called (at most once per pass, non-empty) with iCloud-evicted notes whose
   * content the index lacks: files the pass had to skip unread — a reconcile's
   * stale/rowless placeholders, or every placeholder a rebuild couldn't
   * re-index after the wipe. The desktop layer requests targeted downloads
   * for exactly these; the materialized files then arrive as ordinary watcher
   * upserts and are indexed live. Without a caller wired, evicted content
   * simply stays unindexed until it materializes some other way.
   */
  onStalePlaceholders?: ((paths: readonly string[]) => void) | undefined
}

/**
 * Turns markdown files into index rows.
 */
export interface NoteIndexer {
  /**
   * Read, parse, and (re)index a single note: the read carries `fileGeneration`
   * and the write carries the index `generation`.
   * Without an explicit `mtime` the row is stamped "now": a watcher event
   * means the file just changed, and a real timestamp beats epoch zero (which
   * would sink the note to the bottom of every recency sort and, because
   * reconcile is content-hash gated, never get repaired).
   */
  indexNote(
    path: string,
    options: {
      generation: number
      fileGeneration: number
      content?: string | undefined
      mtime?: number | undefined
    },
  ): Promise<void>
  /**
   * Parse `content` and flatten it into the note's index projection: the one
   * home of the parse, asset-description-gather and build step that every
   * indexing path (single note, rebuild, reconcile, watcher batch) shares.
   * Callers hash first: the hash gates whether this (comparatively expensive)
   * step runs at all. Asset description files are read at `fileGeneration`.
   */
  buildNoteProjection(
    path: string,
    content: string,
    facts: { fileHash: string; mtime: number; fileGeneration: number },
  ): Promise<IndexedNote>
  /**
   * Re-index every note referencing any of `assetPaths` (Plan 20 search
   * integration). Asset descriptions are generated *after* their notes are
   * indexed, so when one is written the referencing notes' search rows are
   * stale; this folds the new description text into their FTS documents.
   * `indexNote` is not hash-gated, so the unchanged note files re-index
   * unconditionally. A note removed since it referenced the asset is
   * skipped. Writes are pinned to `generation`, reads to `fileGeneration`.
   *
   * The re-applied notes broadcast through `emitChangesApplied`, the same
   * post-apply signal the live indexer emits, because these writes bypass the
   * watcher pipeline entirely (`.reflect.md` files are untracked by design).
   * Without it, subscribers that follow the index (the embedding sync above
   * all, which must re-embed the notes so the new description text reaches
   * the semantic leg too) would never hear about description-driven changes.
   */
  reindexNotesReferencing(
    assetPaths: readonly string[],
    options: { generation: number; fileGeneration: number },
  ): Promise<void>
  /**
   * Full rebuild: wipe derived tables and re-index every markdown file. Used
   * for explicit repair and schema-bump triggers, not the hot graph-switch
   * path (that's {@link NoteIndexer.reconcile}). An aborted rebuild may leave
   * a partial index after the wipe; that is intentional for mobile
   * suspension. `index_clear` preserves metadata, so the next foreground sync
   * either rebuilds again for an old stamp or reconciles the missing rows for
   * a current stamp. Both converge without continuing to hold SQLite locks in
   * the background.
   */
  rebuild(options: IndexPassOptions): Promise<void>
  /**
   * The open-path sync: hash-reconcile when the stored rows were built by the
   * current {@link PROJECTION_VERSION}, full rebuild when they weren't (an
   * older app wrote them, or the index has never been stamped). Reconcile
   * compares content hashes only, so it can never refresh rows whose
   * *derivation* changed: without this gate, columns added by a migration
   * would keep their defaults forever on unchanged files.
   */
  sync(options: IndexPassOptions): Promise<void>
  /**
   * Reconcile the index with disk (the open path): re-index files whose
   * content hash changed, and drop rows for files that no longer exist.
   * Cheaper than a full rebuild on an already-populated index, and abortable
   * on graph switch. Writes carry `generation`, so even a pass that races a
   * connection swap can't corrupt the newly-opened index: Rust drops its
   * stale writes.
   *
   * The full-listing comparison lives in Rust (`index_reconcile_scan`): one
   * IPC round-trip returns only the files needing a read (mtime moved, mtime
   * too fresh to trust, or no row yet) with their stored facts riding along,
   * plus the rows whose files vanished. On a healthy graph the delta is empty
   * and the whole pass is that single call. Hashes stay the authority for
   * "did content change": a read whose hash matches skips the write,
   * re-stamping the row's mtime when it disagreed with the listing (an
   * echo-time stamp, or a provider rewrote it) so the mismatch can't cost a
   * re-read on every future pass. Changed notes apply in shared
   * `index_apply_batch` transactions.
   */
  reconcile(options: IndexPassOptions): Promise<void>
}

class NoteIndexerImpl implements NoteIndexer {
  readonly #deps: NoteIndexerDeps
  readonly #assetText: AssetDescriptionText
  readonly #assetReferences: AssetReferences
  readonly #moveHealing: MoveHealing

  constructor(deps: NoteIndexerDeps) {
    this.#deps = deps
    this.#assetText = createAssetDescriptionText(deps)
    this.#assetReferences = createAssetReferences(deps)
    this.#moveHealing = createMoveHealing(deps)
  }

  async buildNoteProjection(
    path: string,
    content: string,
    facts: { fileHash: string; mtime: number; fileGeneration: number },
  ): Promise<IndexedNote> {
    const parsed = parseNote({ path, source: content })
    const text = await this.#assetText.gatherText(
      parsed.assets.map((asset) => asset.path),
      facts.fileGeneration,
    )
    return buildIndexedNote(parsed, {
      fileHash: facts.fileHash,
      mtime: facts.mtime,
      source: content,
      assetText: text,
    })
  }

  async indexNote(
    path: string,
    options: {
      generation: number
      fileGeneration: number
      content?: string | undefined
      mtime?: number | undefined
    },
  ): Promise<void> {
    const { indexStore: store, noteFile, clock } = this.#deps
    const content = options.content ?? (await noteFile.read(path, options.fileGeneration))
    const fileHash = await sha256Hex(content)
    const note = await this.buildNoteProjection(path, content, {
      fileHash,
      mtime: options.mtime ?? clock.now(),
      fileGeneration: options.fileGeneration,
    })
    await store.apply(note, options.generation)
  }

  async reindexNotesReferencing(
    assetPaths: readonly string[],
    options: { generation: number; fileGeneration: number },
  ): Promise<void> {
    const { emitChangesApplied } = this.#deps
    const { generation, fileGeneration } = options
    const notePaths = new Set<string>()
    for (const assetPath of assetPaths) {
      for (const notePath of await this.#assetReferences.notePaths(assetPath)) {
        notePaths.add(notePath)
      }
    }
    const applied: string[] = []
    try {
      for (const notePath of notePaths) {
        try {
          await this.indexNote(notePath, { generation, fileGeneration })
          applied.push(notePath)
        } catch (cause) {
          if (isAppError(cause) && cause.kind === 'notFound') {
            continue // the note was removed since it referenced the asset
          }
          throw cause
        }
      }
    } finally {
      // Emit even when a later note's re-index threw: whatever was applied is
      // real, and unnotified followers would serve stale vectors until the
      // next backfill.
      if (applied.length > 0) {
        emitChangesApplied(
          applied.map((path) => ({ path, kind: 'upsert' as const })),
          generation,
        )
      }
    }
  }

  async rebuild(options: IndexPassOptions): Promise<void> {
    const { indexStore: store, noteFile } = this.#deps
    const { generation, fileGeneration, onSkippedNote, onFileProgress, onStalePlaceholders } =
      options
    if (options.signal?.aborted) {
      return // don't wipe the current index for an already-cancelled pass
    }
    await store.clear(generation)
    if (options.signal?.aborted) {
      return
    }
    const files = await noteFile.listNotes(fileGeneration)
    const batch = store.createApplyBatch(generation, onSkippedNote)
    const evicted: string[] = []
    let done = 0
    let worked = 0
    for (const file of files) {
      if (options.signal?.aborted) {
        return
      }
      done += 1
      if (done % INDEX_PASS_YIELD_EVERY === 0) {
        onFileProgress?.(done, files.length, worked)
        await yieldToEventLoop()
        if (options.signal?.aborted) {
          return
        }
      }
      if (file.placeholder === true) {
        // Evicted to iCloud — unreadable until re-download. The wipe above
        // dropped its row, so after this pass the note is missing from search
        // entirely: surface it for a targeted download, and index it on the
        // materialization upsert.
        evicted.push(file.path)
        continue
      }
      worked += 1
      const content = await noteFile.read(file.path, fileGeneration)
      const fileHash = await sha256Hex(content)
      const projection = await this.buildNoteProjection(file.path, content, {
        fileHash,
        mtime: file.modifiedMs,
        fileGeneration,
      })
      if (options.signal?.aborted) {
        return
      }
      await batch.add(projection)
    }
    if (options.signal?.aborted) {
      return
    }
    await batch.flush()
    if (options.signal?.aborted) {
      return
    }
    onFileProgress?.(files.length, files.length, worked)
    if (evicted.length > 0) {
      onStalePlaceholders?.(evicted)
    }
    // The rows now match the current projection — stamp it so `sync` can
    // reconcile cheaply from here on. A superseded pass stamps into a stale
    // generation, which Rust drops: the next open then rebuilds again, which
    // is the safe direction to fail in.
    await store.setMeta(PROJECTION_VERSION_KEY, String(PROJECTION_VERSION), generation)
  }

  async reconcile(options: IndexPassOptions): Promise<void> {
    const { indexStore: store, noteFile, logger } = this.#deps
    const {
      generation,
      fileGeneration,
      signal,
      onMoved,
      onSkippedNote,
      onFileProgress,
      onStalePlaceholders,
    } = options
    const scan = await store.reconcileScan(generation)
    if (signal?.aborted) {
      return
    }
    if (scan.stalePlaceholders.length > 0) {
      // Evicted notes whose content the index lacks: request their downloads
      // now so they materialize (and index, via watcher upserts) while the
      // pass works through the readable candidates.
      onStalePlaceholders?.(scan.stalePlaceholders)
    }
    /**
     * Stored facts per candidate path; healed moves graft the orphan's in.
     */
    const facts = new Map<string, { mtime: number; fileHash: string }>()
    for (const candidate of scan.candidates) {
      if (candidate.storedMtime !== null && candidate.storedHash !== null) {
        facts.set(candidate.path, { mtime: candidate.storedMtime, fileHash: candidate.storedHash })
      }
    }
    /**
     * Rows to drop at the end: scan orphans, minus heals, plus TOCTOU ghosts.
     */
    const removals = new Map(scan.orphans.map((orphan) => [orphan.path, orphan]))

    // Id-based move healing (Plan 17): a row whose file vanished plus a new
    // file carrying the same frontmatter id is a rename observed after the
    // fact — an external tool or a sync pull moved it while Reflect wasn't
    // looking. Move the rows instead of delete+create, so embedding vectors
    // survive. Best-effort throughout: any failure degrades to the plain pass
    // below (the arrival is indexed fresh, the removal loop drops the orphan).
    // Placeholders can't be arrivals: Rust never lists them as candidates.
    const arrivalPaths = scan.candidates
      .filter((candidate) => candidate.storedHash === null)
      .map((candidate) => candidate.path)
    /**
     * Arrival content read for pairing — the main pass below reuses it.
     */
    let arrivalContent = new Map<string, string>()
    try {
      const healScan = await this.#moveHealing.detectExternalMoves(
        [...removals.keys()],
        arrivalPaths,
        fileGeneration,
        {
          signal,
        },
      )
      arrivalContent = healScan.content
      for (const move of healScan.moves) {
        if (signal?.aborted) {
          return
        }
        try {
          await store.move(move.from, move.to, generation)
        } catch (err) {
          // A refused/failed move (e.g. a row appeared at the destination in a
          // race) degrades to today's delete+create.
          logger.error(`id-based move failed (${move.from} → ${move.to}):`, err)
          continue
        }
        // The moved row carries the old path's facts: the main pass re-indexes
        // at the new path only if the content actually changed in transit.
        const orphan = removals.get(move.from)
        removals.delete(move.from)
        if (orphan !== undefined) {
          facts.set(move.to, { mtime: orphan.storedMtime, fileHash: orphan.storedHash })
        }
        onMoved?.(move.from, move.to)
      }
    } catch (err) {
      // A failed detection (e.g. the id lookup) must not cost the reconcile.
      logger.error('id-based move healing failed; reconciling plainly:', err)
    }
    if (signal?.aborted) {
      return
    }

    const batch = store.createApplyBatch(generation, onSkippedNote)
    const touches = store.createTouchBatch(generation)
    const total = scan.candidates.length
    let done = 0
    let worked = 0
    for (const candidate of scan.candidates) {
      if (signal?.aborted) {
        return
      }
      done += 1
      if (done % INDEX_PASS_YIELD_EVERY === 0) {
        onFileProgress?.(done, total, worked)
        await yieldToEventLoop()
      }
      const stored = facts.get(candidate.path)
      worked += 1
      let content = arrivalContent.get(candidate.path)
      if (content === undefined) {
        try {
          content = await noteFile.read(candidate.path, fileGeneration)
        } catch (err) {
          // The file moved/was deleted/locked between the scan and here (TOCTOU).
          // If it's gone and had a row, that row is now a ghost — remove it this
          // pass; for a transient error keep the row and retry next pass.
          if (isAppError(err) && err.kind === 'notFound' && stored !== undefined) {
            removals.set(candidate.path, {
              path: candidate.path,
              storedMtime: stored.mtime,
              storedHash: stored.fileHash,
            })
          }
          continue
        }
      }
      const fileHash = await sha256Hex(content)
      if (stored?.fileHash === fileHash) {
        // Content unchanged. If the stored mtime doesn't match the listing (an
        // echo-time stamp, or a provider rewrote it), re-stamp it so the next
        // pass takes the read-free path — left alone it mismatches forever.
        if (stored.mtime !== candidate.modifiedMs) {
          if (signal?.aborted) {
            return
          }
          await touches.add({ path: candidate.path, mtime: candidate.modifiedMs })
        }
        continue // unchanged
      }
      if (signal?.aborted) {
        return // re-check after the awaits — don't write for a superseded pass
      }
      const projection = await this.buildNoteProjection(candidate.path, content, {
        fileHash,
        mtime: candidate.modifiedMs,
        fileGeneration,
      })
      if (signal?.aborted) {
        return
      }
      await batch.add(projection)
    }
    if (signal?.aborted) {
      return
    }
    await batch.flush()
    if (signal?.aborted) {
      return
    }
    await touches.flush()
    onFileProgress?.(total, total, worked)

    for (const path of removals.keys()) {
      if (signal?.aborted) {
        return
      }
      await store.remove(path, generation)
    }
  }

  async sync(options: IndexPassOptions): Promise<void> {
    const { indexStore: store, logger } = this.#deps
    const stamped = await store.getMeta(PROJECTION_VERSION_KEY)
    if (stamped === String(PROJECTION_VERSION)) {
      return await this.reconcile(options)
    }
    // Loud on purpose: a rebuild is expected once per projection bump or fresh
    // graph. Seeing this on *every* open means the stamp (or the whole index
    // file) isn't persisting between launches — a pathology that would
    // otherwise be indistinguishable from a slow reconcile.
    logger.warn(
      `index: stored projection version ${stamped === null ? 'none' : `"${stamped}"`} ≠ ${PROJECTION_VERSION} — full rebuild`,
    )
    return await this.rebuild(options)
  }
}

export function createNoteIndexer(deps: NoteIndexerDeps): NoteIndexer {
  return new NoteIndexerImpl(deps)
}
