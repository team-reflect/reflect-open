import { errorMessage, isAppError } from '../errors.ts'
import { createAssetReferences, type AssetReferences } from './asset-refs.ts'
import type { SkippedIndexedNote } from './index-store-service.ts'
import type { IndexingDeps, IndexWriteOutcome, IndexWriter } from './index-writer.ts'
import { PROJECTION_VERSION } from './indexed-note.ts'
import { INDEX_PASS_YIELD_EVERY } from './pacing.ts'

/**
 * The whole-graph index passes (Plan 04). A pass finds the files that may
 * differ from the index and marks them dirty; the {@link IndexWriter} reads,
 * parses, and writes them. The index is a rebuildable cache.
 *
 * Every write carries the writer's index generation, and every file read its
 * file generation. Rust no-ops a write whose generation is stale, so a pass
 * started for one graph can never mutate a newly-opened index. The
 * `AbortSignal` makes a superseded pass return early; the paths it marked
 * stay dirty and the writer still writes them.
 */

/**
 * The `index_meta` key holding the {@link PROJECTION_VERSION} the stored rows
 * were built with. Stamped after every full rebuild; `index_clear` preserves
 * `index_meta`, and the stamp is rewritten once the rebuild completes.
 */
export const PROJECTION_VERSION_KEY = 'projection_version'

/**
 * Options for the long-running index passes.
 */
export interface IndexPassOptions {
  /**
   * The writer of the index session the pass runs for. The pass scans at its
   * index generation, lists files at its file generation, and marks the files
   * to write in its dirty set.
   */
  writer: IndexWriter
  /**
   * Makes the pass return early when the active graph changes.
   */
  signal?: AbortSignal
  /**
   * Called when the writer cannot write one note's projection even alone. The
   * pass continues so one bad projection cannot leave the whole cache empty
   * after `index_clear`. If omitted, that failure is thrown once the writer
   * settled every file of the pass.
   */
  onSkippedNote?: (note: SkippedIndexedNote) => void
  /**
   * Called as the writer settles the files of the pass — every
   * {@link INDEX_PASS_YIELD_EVERY} files and once at the end — so a first
   * index over thousands of notes can show real progress instead of a frozen
   * shell. `done` counts every file the pass has moved past (skipped or
   * settled); `total` is the number of files of the pass; `worked` counts the
   * files handed to the writer so far (not skipped as placeholders). `worked`
   * is what distinguishes a genuine first index from a routine repeat pass
   * that finds nothing to do — the progress UI must gate on it, or a healthy
   * sub-second pass flashes a "preparing" surface on every open.
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
 * Finds the files the index is behind on and hands them to the index writer.
 */
export interface NoteIndexer {
  /**
   * Re-index every note referencing any of `assetPaths` (Plan 20 search
   * integration) through `writer`. Asset descriptions are generated *after*
   * their notes are indexed, so when one is written the referencing notes'
   * search rows are stale; this folds the new description text into their
   * FTS documents. The note files are unchanged, so each path is marked dirty
   * with `force`. A note removed since it referenced the asset is skipped.
   * Any other failure is thrown after the writer settled every note.
   *
   * The writer reports the re-applied notes like any other change, so
   * subscribers that follow the index (the embedding sync above all, which
   * must re-embed the notes so the new description text reaches the semantic
   * leg too) hear about description-driven changes.
   */
  reindexNotesReferencing(assetPaths: readonly string[], writer: IndexWriter): Promise<void>
  /**
   * Full rebuild: wipe derived tables and mark every markdown file dirty.
   * Used for explicit repair and schema-bump triggers, not the hot
   * graph-switch path (that's {@link NoteIndexer.reconcile}).
   *
   * Like every pass, resolves `true` when it ran to completion and `false`
   * when it returned early (aborted, or the writer paused). A rebuild that
   * returns early may leave a partial index after the wipe and no version
   * stamp; that is intentional for mobile suspension. `index_clear` preserves
   * metadata, so the next foreground sync either rebuilds again for an old
   * stamp or reconciles the missing rows for a current stamp.
   */
  rebuild(options: IndexPassOptions): Promise<boolean>
  /**
   * The open-path sync: reconcile when the stored rows were built by the
   * current {@link PROJECTION_VERSION}, full rebuild when they weren't (an
   * older app wrote them, or the index has never been stamped). Reconcile
   * compares content hashes only, so it can never refresh rows whose
   * *derivation* changed: without this gate, columns added by a migration
   * would keep their defaults forever on unchanged files.
   */
  sync(options: IndexPassOptions): Promise<boolean>
  /**
   * Reconcile the index with disk (the open path): mark the files whose
   * mtime moved or that have no row as dirty upserts, and the rows whose
   * files vanished as dirty removes. Cheaper than a full rebuild on an
   * already-populated index.
   *
   * The full-listing comparison lives in Rust (`index_reconcile_scan`): one
   * IPC round-trip returns only the files needing a read (mtime moved, mtime
   * too fresh to trust, or no row yet), plus the rows whose files vanished.
   * On a healthy graph the delta is empty and the whole pass is that single
   * call. The writer keeps hashes as the authority for "did content change",
   * and heals a vanished row plus an arrived file with the same frontmatter
   * id as a move (Plan 17).
   */
  reconcile(options: IndexPassOptions): Promise<boolean>
}

class NoteIndexerImpl implements NoteIndexer {
  readonly #deps: IndexingDeps
  readonly #assetReferences: AssetReferences

  constructor(deps: IndexingDeps) {
    this.#deps = deps
    this.#assetReferences = createAssetReferences(deps)
  }

  async reindexNotesReferencing(assetPaths: readonly string[], writer: IndexWriter): Promise<void> {
    const notePaths = new Set<string>()
    for (const assetPath of assetPaths) {
      for (const notePath of await this.#assetReferences.notePaths(assetPath)) {
        notePaths.add(notePath)
      }
    }
    for (const notePath of notePaths) {
      writer.dirty.add(notePath, { force: true })
    }
    const outcomes = await Promise.all([...notePaths].map((path) => writer.settled(path)))
    for (const outcome of outcomes) {
      if (outcome.status !== 'failed') {
        continue
      }
      if (isAppError(outcome.error) && outcome.error.kind === 'notFound') {
        continue // the note was removed since it referenced the asset
      }
      throw outcome.error
    }
  }

  async rebuild(options: IndexPassOptions): Promise<boolean> {
    const { indexStore: store, noteFile } = this.#deps
    const { writer, signal, onSkippedNote, onFileProgress, onStalePlaceholders } = options
    if (signal?.aborted) {
      return false // don't wipe the current index for an already-cancelled pass
    }
    await writer.clear()
    if (signal?.aborted) {
      return false
    }
    const files = await noteFile.listNotes(writer.fileGeneration)
    if (signal?.aborted) {
      return false
    }
    // Evicted to iCloud — unreadable until re-download. The wipe above dropped
    // their rows, so after this pass these notes are missing from search
    // entirely: surface them for a targeted download, and index each on its
    // materialization upsert.
    const evicted = files.filter((file) => file.placeholder === true).map((file) => file.path)
    const readable = files.filter((file) => file.placeholder !== true)
    for (const file of readable) {
      writer.dirty.add(file.path, { modifiedMs: file.modifiedMs, bulk: true })
    }
    const outcomes = await this.#settlePaths(
      writer,
      readable.map((file) => file.path),
      signal,
      (worked) => {
        onFileProgress?.(evicted.length + worked, files.length, worked)
      },
    )
    if (outcomes === null) {
      return false
    }
    for (const [path, outcome] of outcomes) {
      if (outcome.status !== 'failed') {
        continue
      }
      if (outcome.stage === 'read' || onSkippedNote === undefined) {
        throw outcome.error
      }
      onSkippedNote({ path, message: errorMessage(outcome.error) })
    }
    onFileProgress?.(files.length, files.length, readable.length)
    if (evicted.length > 0) {
      onStalePlaceholders?.(evicted)
    }
    // The rows now match the current projection — stamp it so `sync` can
    // reconcile cheaply from here on. A superseded pass stamps into a stale
    // generation, which Rust drops: the next open then rebuilds again, which
    // is the safe direction to fail in.
    await store.setMeta(PROJECTION_VERSION_KEY, String(PROJECTION_VERSION), writer.generation)
    return true
  }

  async reconcile(options: IndexPassOptions): Promise<boolean> {
    const { indexStore: store } = this.#deps
    const { writer, signal, onSkippedNote, onFileProgress, onStalePlaceholders } = options
    const scan = await store.reconcileScan(writer.generation)
    if (signal?.aborted) {
      return false
    }
    if (scan.stalePlaceholders.length > 0) {
      // Evicted notes whose content the index lacks: request their downloads
      // now so they materialize (and index, via watcher upserts) while the
      // writer works through the readable candidates.
      onStalePlaceholders?.(scan.stalePlaceholders)
    }
    for (const candidate of scan.candidates) {
      writer.dirty.add(candidate.path, { modifiedMs: candidate.modifiedMs, bulk: true })
    }
    for (const orphan of scan.orphans) {
      writer.dirty.add(orphan.path, { kind: 'remove', bulk: true })
    }
    const total = scan.candidates.length
    const outcomes = await this.#settlePaths(
      writer,
      [...scan.candidates, ...scan.orphans].map((file) => file.path),
      signal,
      (settled) => {
        const done = Math.min(settled, total)
        onFileProgress?.(done, total, done)
      },
    )
    if (outcomes === null) {
      return false
    }
    const indexed = new Set(
      scan.candidates
        .filter((candidate) => candidate.storedHash !== null)
        .map((candidate) => candidate.path),
    )
    /**
     * Rows whose file vanished between the scan and the read.
     */
    const ghosts: string[] = []
    for (const [path, outcome] of outcomes) {
      if (outcome.status !== 'failed') {
        continue
      }
      if (outcome.stage === 'read') {
        // A file that is gone leaves a ghost row to remove in this pass. Any
        // other read failure keeps the row for the next pass.
        if (isAppError(outcome.error) && outcome.error.kind === 'notFound' && indexed.has(path)) {
          ghosts.push(path)
        }
        continue
      }
      if (onSkippedNote === undefined) {
        throw outcome.error
      }
      onSkippedNote({ path, message: errorMessage(outcome.error) })
    }
    for (const path of ghosts) {
      writer.dirty.add(path, { kind: 'remove', bulk: true })
    }
    const removals = await this.#settlePaths(writer, ghosts, signal, undefined)
    if (removals === null) {
      return false
    }
    for (const outcome of removals.values()) {
      if (outcome.status === 'failed') {
        throw outcome.error
      }
    }
    onFileProgress?.(total, total, total)
    return true
  }

  async sync(options: IndexPassOptions): Promise<boolean> {
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

  /**
   * Wait until the writer settled each of `paths`. Resolves with the outcome
   * of every path, or with `null` when the pass cannot complete: `signal`
   * aborted, or the writer deferred a path. `onSettled` receives the number
   * of settled paths every {@link INDEX_PASS_YIELD_EVERY} paths.
   */
  async #settlePaths(
    writer: IndexWriter,
    paths: readonly string[],
    signal: AbortSignal | undefined,
    onSettled: ((settled: number) => void) | undefined,
  ): Promise<Map<string, IndexWriteOutcome> | null> {
    const outcomes = new Map<string, IndexWriteOutcome>()
    const aborted = Promise.withResolvers<null>()
    const stopWaiting = new AbortController()
    signal?.addEventListener(
      'abort',
      () => {
        aborted.resolve(null)
      },
      { signal: stopWaiting.signal },
    )
    const settled = Promise.all(
      paths.map(async (path) => {
        const outcome = await writer.settled(path)
        outcomes.set(path, outcome)
        if (outcomes.size % INDEX_PASS_YIELD_EVERY === 0 && signal?.aborted !== true) {
          onSettled?.(outcomes.size)
        }
      }),
    )
    try {
      if (signal?.aborted === true || (await Promise.race([settled, aborted.promise])) === null) {
        return null
      }
    } finally {
      stopWaiting.abort()
    }
    for (const outcome of outcomes.values()) {
      if (outcome.status === 'deferred') {
        return null
      }
    }
    return outcomes
  }
}

export function createNoteIndexer(deps: IndexingDeps): NoteIndexer {
  return new NoteIndexerImpl(deps)
}
