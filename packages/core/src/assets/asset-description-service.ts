import type { AiCredentialService } from '../ai/ai-credential-service.ts'
import { base64ByteLength, base64ToUtf8, sha256Hex } from '@reflect/utils'
import type { AiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import {
  isAssetDescriptionRejected,
  type AssetDescriberService,
} from '../ai/asset-describer-service.ts'
import type {
  BackgroundReconciler,
  BackgroundReconcilerFactory,
} from '../reconcile/background-reconciler.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { GraphSession, GraphSessionSource } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import { isSilentStop, type ReconcileStop } from '../reconcile/reconcile.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { ASSETS_DIR, descriptionPathFor, isNotePath } from '../graph/paths.ts'
import type { FileMeta } from '../graph/schemas.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { parseNote } from '../markdown/extract.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import {
  assetTypeFor,
  buildDescriptionSource,
  isEligibleAssetPath,
  readManagedDescription,
  type ManagedDescription,
} from './asset-description-helpers.ts'
import type { AssetPrivacyService } from './asset-privacy-service.ts'

/**
 * Largest source we send to a provider; bigger assets are skipped, not sent.
 */
const MAX_ASSET_BYTES = 20 * 1024 * 1024

/**
 * Whether new eligible assets are described automatically vs. only on backfill.
 */
export type AssetDescriptionMode = 'incremental' | 'backfill'

export interface ReconcileAssetDescriptionsInput {
  /**
   * `GraphInfo.generation` — pins every read/write to the issuing graph.
   */
  generation: number
  /**
   * `incremental` processes `changed`; `backfill` enumerates every asset.
   */
  mode: AssetDescriptionMode
  /**
   * Incremental only: the eligible asset paths the watcher reported changed.
   */
  changed?: readonly string[]
  /**
   * Abort gate, checked between assets and after each slow await.
   */
  isStale?: () => boolean
  /**
   * Backfill progress: `(processed, total)` after each handled asset.
   */
  onProgress?: (processed: number, total: number) => void
}

export interface ReconcileAssetDescriptionsOutcome {
  /**
   * Eligible assets this pass considered.
   */
  pending: number
  /**
   * Assets described and written this pass.
   */
  described: number
  /**
   * Skipped — a managed description already matched the source hash.
   */
  skippedUpToDate: number
  /**
   * Skipped — referenced by no public note (or none at all).
   */
  skippedUnreferenced: number
  /**
   * Skipped — referenced by a private note (the hard block).
   */
  skippedPrivate: number
  /**
   * Skipped — an existing description was user-authored, never overwritten.
   */
  skippedUserAuthored: number
  /**
   * Skipped — larger than the size cap.
   */
  skippedOversize: number
  /**
   * Permanent provider refusals — logged, no description written.
   */
  refused: number
  /**
   * Asset paths for which a description was written this pass. The session
   * and the backfill re-index the notes referencing them so the new text
   * becomes searchable (`IndexLifecycleService.reindexNotesReferencing`).
   */
  describedAssetPaths: string[]
  /**
   * Why the pass ended early, or `null` when every asset was handled.
   */
  stopped: ReconcileStop | null
}

/**
 * Why an asset was skipped (no description written, nothing sent).
 */
type AssetSkipReason =
  | 'up-to-date'
  | 'unreferenced'
  | 'private'
  | 'user-authored'
  | 'oversize'
  | 'gone'

/**
 * Per-asset result; `stop` ends the whole pass, everything else is a tally.
 */
type AssetStep =
  | { kind: 'described' }
  | { kind: 'skipped'; reason: AssetSkipReason }
  | { kind: 'refused' }
  | { kind: 'stop'; stopped: ReconcileStop }

/**
 * The mutable counters a pass accumulates; spread verbatim into the outcome.
 */
interface AssetTally {
  described: number
  skippedUpToDate: number
  skippedUnreferenced: number
  skippedPrivate: number
  skippedUserAuthored: number
  skippedOversize: number
  refused: number
}

/**
 * Which {@link AssetTally} counter each skip reason increments. `gone` (the asset
 * vanished since it was observed, or an ineligible path slipped in) counts as
 * unreferenced — either way nothing was read, hashed, or sent.
 */
const SKIP_COUNTER: Readonly<Record<AssetSkipReason, keyof AssetTally>> = {
  'up-to-date': 'skippedUpToDate',
  unreferenced: 'skippedUnreferenced',
  gone: 'skippedUnreferenced',
  private: 'skippedPrivate',
  'user-authored': 'skippedUserAuthored',
  oversize: 'skippedOversize',
}

interface AssetContext {
  config: AiProviderConfig
  apiKey: string
  generation: number
  isStale: () => boolean
  /**
   * `assets/` file stats (size + mtime), to skip reads we can prove are stale.
   */
  statByPath: Map<string, FileMeta>
}

const STALE: ReconcileStop = { reason: 'stale', message: 'the graph session ended mid-pass' }

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

interface AssetCandidates {
  /**
   * Eligible asset paths to consider this pass.
   */
  paths: string[]
  /**
   * The `assets/` listing when the mode already fetched it (backfill), else null.
   */
  listing: FileMeta[] | null
}

/**
 * The automatic asset-description lifecycle for one graph session. Built on
 * `BackgroundReconcilerFactory` (shared with capture and transcription):
 * the single-flight loop, focus/online retries, and teardown live there; this
 * supplies the asset-specific pass and triggers.
 *
 * Triggers fire off `IndexLifecycleService.onApplied` — the indexer's
 * POST-APPLY signal — not the raw watcher stream, so the privacy gate always
 * reads a settled index and can't race a just-written private note's
 * indexing. It describes **new** eligible assets only — there is no launch
 * backfill ({@link AssetDescriptionService.backfillVisibly} handles existing
 * assets). Observed assets accumulate in a dirty set; each pass reconciles it.
 * A transient (auth/network) stop leaves the set intact so the next trigger
 * retries; a clean pass clears it. Re-describing an unchanged asset is cheap —
 * its managed description's hash matches, so no provider call is made.
 */
export interface AssetDescriptionSession {
  /**
   * Attach the triggers (index-applied, focus, online). No launch backfill.
   */
  start(): void
  /**
   * Request a pass; coalesces while one runs (at most one follow-up).
   */
  schedule(): void
  /**
   * Tear down triggers and abort an in-flight pass at its next gate.
   */
  dispose(): void
}

export interface AssetDescriptionSessionOptions {
  /**
   * The open graph's generation — every pass's reads and writes pin to it.
   */
  generation: number
  /**
   * The open graph's index generation, or `null` when its index failed to open.
   */
  indexGeneration: number | null
}

/**
 * Asset descriptions (Plan 20). For each eligible image/PDF under `assets/`
 * that is safely associated with public notes, generate a managed markdown
 * description file (`<asset>.reflect.md`) holding an AI description + OCR,
 * then fold the new text into the referencing notes' search rows.
 *
 * Privacy is a hard block — an asset referenced by any private note is never
 * sent.
 */
export interface AssetDescriptionService {
  /**
   * Describe every candidate asset that needs it. `incremental` mode handles the
   * eligible paths in `changed`; `backfill` mode enumerates every eligible asset
   * under `assets/`. Idempotent in both modes: a managed description whose source
   * hash still matches is skipped, so re-runs are cheap. Never throws.
   *
   * Generation-pinned, abortable between items via `isStale`, and the retry
   * layer for transient provider failures (auth/network stop the pass; the
   * next trigger re-runs it). The caller serializes passes. The default
   * provider and its key are read at the start of every pass — a provider
   * added in Settings mid-session must be seen by the very next pass.
   */
  reconcile(input: ReconcileAssetDescriptionsInput): Promise<ReconcileAssetDescriptionsOutcome>
  /**
   * Build the automatic lifecycle for one graph session. `dispose()` is terminal.
   */
  openSession(options: AssetDescriptionSessionOptions): AssetDescriptionSession
  /**
   * Describe every existing eligible asset with user-visible status (Plan 20):
   * the explicit backfill behind the Settings button + cost warning. Unlike the
   * automatic path it enumerates all of `assets/`, but obeys the same privacy and
   * idempotency rules — already-described assets are skipped, and private or
   * unreferenced ones are never sent. Pinned to the open graph; coalesces
   * while a run for that graph is in flight. Without an open graph it stops
   * at once with a `noGraph` stop and no operation.
   */
  backfillVisibly(): Promise<ReconcileAssetDescriptionsOutcome>
  /**
   * Fires after a pass re-indexed the notes referencing the assets it
   * described, even when that re-index failed partway. The re-index writes
   * search rows directly (not via the watcher), so holders of index-backed
   * caches refresh off this.
   */
  onDescriptionsIndexed(listener: () => void): Unlisten
}

export interface AssetDescriptionServiceDeps {
  readonly assetStore: AssetStoreService
  readonly noteFile: NoteFileService
  readonly assetPrivacy: AssetPrivacyService
  readonly assetDescriber: AssetDescriberService
  readonly aiProviderConfig: AiProviderConfigService
  readonly aiCredentials: AiCredentialService
  readonly clock: ClockService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly indexLifecycle: IndexLifecycleService
  readonly progress: ProgressPort
  readonly graphSession: GraphSessionSource
  readonly logger: LoggerService
}

interface AssetDescriptionSessionDeps {
  readonly noteFile: NoteFileService
  readonly indexLifecycle: IndexLifecycleService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly logger: LoggerService
  readonly reconcile: (
    input: ReconcileAssetDescriptionsInput,
  ) => Promise<ReconcileAssetDescriptionsOutcome>
  readonly emitDescriptionsIndexed: () => void
}

class AssetDescriptionSessionImpl implements AssetDescriptionSession {
  readonly #deps: AssetDescriptionSessionDeps
  readonly #options: AssetDescriptionSessionOptions
  readonly #loop: BackgroundReconciler
  /**
   * Eligible assets observed changed and not yet successfully reconciled.
   */
  readonly #dirty = new Set<string>()
  #started = false
  /**
   * Last logged stop message — retries must not re-log it.
   */
  #loggedStop: string | null = null

  constructor(deps: AssetDescriptionSessionDeps, options: AssetDescriptionSessionOptions) {
    this.#deps = deps
    this.#options = options
    this.#loop = deps.reconcilers.create({ pass: this.#pass })
  }

  start(): void {
    const { indexLifecycle } = this.#deps
    const { indexGeneration } = this.#options
    if (this.#started || this.#loop.isStale()) {
      return // idempotent: never register the wake/index listeners twice
    }
    this.#started = true
    this.#loop.retryOnWake() // retry assets a prior pass left dirty after coming back online
    // Drive off the indexer's POST-APPLY signal, not the raw watcher stream: when
    // this fires the batch's note rows (privacy flags, `assets` projection) are
    // already in the index, so the privacy gate can't race a just-written private
    // note's indexing. Carries the full batch — asset-file upserts (a dropped
    // image) and note upserts (which may newly reference an asset).
    this.#loop.onDispose(
      indexLifecycle.onApplied((event) => {
        if (event.generation !== indexGeneration || event.changes === null) {
          return // a delayed emit from a graph we've switched away from, or a sync pass
        }
        const newAssets: string[] = []
        const changedNotes: string[] = []
        for (const change of event.changes) {
          if (change.kind !== 'upsert') {
            continue
          }
          if (isEligibleAssetPath(change.path)) {
            newAssets.push(change.path)
          } else if (isNotePath(change.path)) {
            changedNotes.push(change.path)
          }
        }
        if (newAssets.length > 0) {
          this.#markDirty(newAssets)
        }
        if (changedNotes.length > 0) {
          void this.#markAssetsFromNotes(changedNotes)
        }
      }),
    )
  }

  schedule(): void {
    this.#loop.schedule()
  }

  dispose(): void {
    this.#loop.dispose()
  }

  #surfaceStop(stopped: ReconcileStop | null): void {
    if (stopped === null) {
      this.#loggedStop = null
      return
    }
    // Automatic description is background, best-effort work, so it never toasts:
    // self-healing stops (network/config/stale) stay silent, and the Settings
    // backfill is the user-initiated path that surfaces progress and errors. An
    // index-not-ready (io) failure during startup is unexpected here, so it is
    // logged (deduped) for diagnosis only.
    if (isSilentStop(stopped) || this.#loggedStop === stopped.message) {
      return
    }
    this.#loggedStop = stopped.message
    this.#deps.logger.warn(`asset description stopped (${stopped.reason}): ${stopped.message}`)
  }

  /**
   * One reconcile pass over the dirty set, then fold any new descriptions into
   * the referencing notes' search rows so a query matching a description
   * surfaces the note (Plan 20 search integration). Returns `'stop'` on a
   * transient/config stop so the loop keeps the batch for the next trigger
   * instead of spinning.
   */
  readonly #pass = async (isStale: () => boolean): Promise<void | 'stop'> => {
    const { indexLifecycle, logger, reconcile, emitDescriptionsIndexed } = this.#deps
    const { generation, indexGeneration } = this.#options
    if (this.#dirty.size === 0) {
      return // nothing pending
    }
    const batch = [...this.#dirty]
    const outcome = await reconcile({
      generation,
      mode: 'incremental',
      changed: batch,
      isStale,
    })
    this.#surfaceStop(outcome.stopped)
    if (isStale()) {
      return 'stop'
    }
    // Runs even on a stop — whatever was described is real. A re-index failure
    // must not crash the loop: the descriptions are written, so search catches
    // up on the note's next re-index or a rebuild. The re-index emits the
    // post-apply signal for the refreshed notes (the embedding sync re-embeds
    // them off it); our own index-applied trigger hears that emit too and
    // re-marks the notes' assets, which the next pass skips as up-to-date —
    // one cheap extra cycle, no loop (a clean pass writes nothing new).
    if (outcome.describedAssetPaths.length > 0 && indexGeneration !== null) {
      try {
        await indexLifecycle.reindexNotesReferencing(outcome.describedAssetPaths, {
          generation: indexGeneration,
          fileGeneration: generation,
        })
      } catch (cause) {
        logger.warn('asset-description re-index failed:', cause)
      }
      // The re-index wrote search rows directly (not via the watcher → onApplied
      // path), so nothing invalidated the index-backed query caches. Listeners
      // refresh them so ⌘K reflects the new descriptions.
      emitDescriptionsIndexed()
    }
    if (isStale()) {
      return 'stop'
    }
    if (outcome.stopped !== null) {
      return 'stop' // transient/config stop: keep the batch, wait for the next trigger
    }
    for (const path of batch) {
      this.#dirty.delete(path)
    }
  }

  #markDirty(paths: readonly string[]): void {
    let added = false
    for (const path of paths) {
      if (!this.#dirty.has(path)) {
        this.#dirty.add(path)
        added = true
      }
    }
    if (added) {
      this.#loop.schedule()
    }
  }

  /**
   * A note changed — re-evaluate the eligible assets it references. This is the
   * "relevant note changes" trigger: an asset already on disk that a note edit
   * newly makes public (referenced by a non-private note) gets described, even
   * though the asset file itself did not change. Already-described assets fall
   * through the reconcile's hash check cheaply, so re-marking is harmless.
   */
  async #markAssetsFromNotes(notePaths: readonly string[]): Promise<void> {
    const referenced = new Set<string>()
    for (const notePath of notePaths) {
      if (this.#loop.isStale()) {
        return
      }
      let source: string
      try {
        source = await this.#deps.noteFile.read(notePath, this.#options.generation)
      } catch {
        continue // deleted/unreadable since the change — nothing to re-evaluate
      }
      for (const asset of parseNote({ path: notePath, source }).assets) {
        if (isEligibleAssetPath(asset.path)) {
          referenced.add(asset.path)
        }
      }
    }
    if (referenced.size > 0 && !this.#loop.isStale()) {
      this.#markDirty([...referenced])
    }
  }
}

class AssetDescriptionServiceImpl implements AssetDescriptionService {
  readonly #deps: AssetDescriptionServiceDeps
  readonly #indexedListeners = new Set<() => void>()
  #backfillInFlight: {
    generation: number
    promise: Promise<ReconcileAssetDescriptionsOutcome>
  } | null = null

  constructor(deps: AssetDescriptionServiceDeps) {
    this.#deps = deps
  }

  async reconcile(
    input: ReconcileAssetDescriptionsInput,
  ): Promise<ReconcileAssetDescriptionsOutcome> {
    const { aiProviderConfig, aiCredentials } = this.#deps
    const tally: AssetTally = {
      described: 0,
      skippedUpToDate: 0,
      skippedUnreferenced: 0,
      skippedPrivate: 0,
      skippedUserAuthored: 0,
      skippedOversize: 0,
      refused: 0,
    }
    const describedAssetPaths: string[] = []
    const outcome = (
      pending: number,
      stopped: ReconcileStop | null,
    ): ReconcileAssetDescriptionsOutcome => ({ pending, ...tally, describedAssetPaths, stopped })

    let candidate: AssetCandidates
    try {
      candidate = await this.#candidateAssets(input)
    } catch (cause) {
      return outcome(0, { reason: toAppError(cause).kind, message: errorMessage(cause) })
    }

    const total = candidate.paths.length
    if (total === 0) {
      return outcome(0, null)
    }

    // Re-resolved every pass: a provider added in Settings mid-session must be
    // seen by the very next pass. Unlike capture there is no non-AI fallback —
    // no provider means nothing can be described, so the pass stops.
    const config = aiProviderConfig.defaultProvider()
    if (config === null) {
      return outcome(total, { reason: 'config', message: 'No AI provider is configured.' })
    }
    const apiKey = await aiCredentials.read(config).catch(() => null)
    if (apiKey === null) {
      return outcome(total, {
        reason: 'config',
        message: `The API key for the configured ${config.provider} model is missing from the keychain.`,
      })
    }

    const ctx: AssetContext = {
      config,
      apiKey,
      generation: input.generation,
      isStale: () => input.isStale?.() === true,
      statByPath: await this.#statMap(input, candidate.listing),
    }

    let processed = 0
    for (const assetPath of candidate.paths) {
      if (ctx.isStale()) {
        return outcome(total, STALE)
      }
      let step: AssetStep
      try {
        step = await this.#processAsset(assetPath, ctx)
      } catch (cause) {
        return outcome(total, { reason: toAppError(cause).kind, message: errorMessage(cause) })
      }
      if (step.kind === 'stop') {
        return outcome(total, step.stopped)
      }
      if (step.kind === 'described') {
        tally.described += 1
        describedAssetPaths.push(assetPath)
      } else if (step.kind === 'refused') {
        tally.refused += 1
      } else {
        tally[SKIP_COUNTER[step.reason]] += 1
      }
      processed += 1
      input.onProgress?.(processed, total)
    }
    return outcome(total, null)
  }

  openSession(options: AssetDescriptionSessionOptions): AssetDescriptionSession {
    const { noteFile, indexLifecycle, reconcilers, logger } = this.#deps
    return new AssetDescriptionSessionImpl(
      {
        noteFile,
        indexLifecycle,
        reconcilers,
        logger,
        reconcile: (input) => this.reconcile(input),
        emitDescriptionsIndexed: () => {
          this.#emitDescriptionsIndexed()
        },
      },
      options,
    )
  }

  backfillVisibly(): Promise<ReconcileAssetDescriptionsOutcome> {
    const { session } = this.#deps.graphSession.getState()
    if (session === null) {
      return Promise.resolve({
        pending: 0,
        described: 0,
        skippedUpToDate: 0,
        skippedUnreferenced: 0,
        skippedPrivate: 0,
        skippedUserAuthored: 0,
        skippedOversize: 0,
        refused: 0,
        describedAssetPaths: [],
        stopped: { reason: 'noGraph', message: 'No graph is open.' },
      })
    }
    const { generation } = session
    if (this.#backfillInFlight !== null && this.#backfillInFlight.generation === generation) {
      return this.#backfillInFlight.promise
    }
    const promise = this.#runBackfill(session).finally(() => {
      if (this.#backfillInFlight !== null && this.#backfillInFlight.promise === promise) {
        this.#backfillInFlight = null
      }
    })
    this.#backfillInFlight = { generation, promise }
    return promise
  }

  onDescriptionsIndexed(listener: () => void): Unlisten {
    const deliver = (): void => {
      listener()
    }
    this.#indexedListeners.add(deliver)
    return () => {
      this.#indexedListeners.delete(deliver)
    }
  }

  #emitDescriptionsIndexed(): void {
    for (const listener of this.#indexedListeners) {
      listener()
    }
  }

  async #readDescriptionSource(path: string, generation: number): Promise<string | null> {
    try {
      return await this.#deps.noteFile.read(path, generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return null
      }
      throw cause
    }
  }

  /**
   * Process one asset. Throws on transient (auth/network) failure to stop the pass.
   */
  async #processAsset(assetPath: string, ctx: AssetContext): Promise<AssetStep> {
    const { assetStore, noteFile, assetPrivacy, assetDescriber, clock } = this.#deps
    const assetType = assetTypeFor(assetPath)
    if (assetType === null) {
      return { kind: 'skipped', reason: 'gone' } // defensive: an ineligible path slipped in
    }

    // Gate first, on the notes index: never read or send an asset's bytes until a
    // non-private note is associated with it (and no private note is). Waiting for
    // the association before attempting keeps private and unreferenced assets
    // entirely untouched — they are never read, hashed, or sent to a provider.
    const verdict = await assetPrivacy.classifyAsset(assetPath, ctx.generation)
    if (ctx.isStale()) {
      return { kind: 'stop', stopped: STALE }
    }
    if (verdict === 'skip-private') {
      return { kind: 'skipped', reason: 'private' }
    }
    if (verdict === 'skip-unreferenced') {
      return { kind: 'skipped', reason: 'unreferenced' }
    }

    // Read the (small) description and identify a user-authored file we must never
    // touch. The up-to-date decision is the content hash below — never mtime/size,
    // which an mtime-preserving replacement (`cp -p`, a restore, a sync) could spoof
    // into a false skip and strand a stale description; the index compares content
    // hashes for the same reason (see indexing/hash). The stat is used only for the
    // pre-read size cap.
    const stat = ctx.statByPath.get(assetPath)
    const descriptionPath = descriptionPathFor(assetPath)
    const existing = await this.#readDescriptionSource(descriptionPath, ctx.generation)
    let managed: ManagedDescription | null = null
    if (existing !== null) {
      managed = readManagedDescription(existing)
      if (managed === null) {
        return { kind: 'skipped', reason: 'user-authored' }
      }
    }

    // Cap before reading when the stat is known — never pull an oversize file's
    // bytes into memory just to skip it.
    if (stat !== undefined && stat.size > MAX_ASSET_BYTES) {
      return { kind: 'skipped', reason: 'oversize' }
    }

    let base64: string
    try {
      base64 = await assetStore.readBase64(assetPath, ctx.generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return { kind: 'skipped', reason: 'gone' } // removed since it was observed
      }
      throw cause
    }

    const sourceSize = base64ByteLength(base64)
    if (sourceSize > MAX_ASSET_BYTES) {
      return { kind: 'skipped', reason: 'oversize' } // belt: no stat was available
    }

    const sourceHash = await sha256Hex(base64)
    if (managed !== null && managed.sourceHash === sourceHash) {
      return { kind: 'skipped', reason: 'up-to-date' } // mtime moved but content identical
    }

    if (ctx.isStale()) {
      return { kind: 'stop', stopped: STALE }
    }

    let body: string
    try {
      body = await assetDescriber.describe({
        config: ctx.config,
        apiKey: ctx.apiKey,
        kind: assetType.kind,
        mediaType: assetType.mediaType,
        data: assetType.kind === 'svg' ? base64ToUtf8(base64) : base64,
        filename: basename(assetPath),
      })
    } catch (cause) {
      if (isAssetDescriptionRejected(cause)) {
        return { kind: 'refused' } // permanent — log only, no failure description
      }
      throw cause // auth/network — stop the pass, retry on the next trigger
    }
    if (ctx.isStale()) {
      return { kind: 'stop', stopped: STALE }
    }
    if (body === '') {
      return { kind: 'refused' } // an empty description is as useless as a refusal
    }

    await noteFile.write(
      descriptionPath,
      buildDescriptionSource(
        {
          source: assetPath,
          sourceHash,
          sourceSize,
          provider: ctx.config.provider,
          model: ctx.config.model,
          generatedAt: new Date(clock.now()).toISOString(),
        },
        body,
      ),
      ctx.generation,
    )
    return { kind: 'described' }
  }

  async #candidateAssets(input: ReconcileAssetDescriptionsInput): Promise<AssetCandidates> {
    const { noteFile } = this.#deps
    if (input.mode === 'backfill') {
      const listing = await noteFile.listDir(ASSETS_DIR, input.generation)
      return {
        // iCloud-evicted assets list under their logical names but aren't
        // readable until downloaded — they get described on a later pass.
        paths: listing
          .filter((file) => file.placeholder !== true)
          .map((file) => file.path)
          .filter(isEligibleAssetPath),
        listing,
      }
    }
    const unique = new Set<string>()
    for (const path of input.changed ?? []) {
      if (isEligibleAssetPath(path)) {
        unique.add(path)
      }
    }
    return { paths: [...unique], listing: null }
  }

  /**
   * File stats for the candidates, keyed by path. Reuses backfill's listing; for
   * incremental it lists `assets/` best-effort — a failure just means the pass
   * reads every asset instead of skipping unchanged ones by stat.
   */
  async #statMap(
    input: ReconcileAssetDescriptionsInput,
    listing: FileMeta[] | null,
  ): Promise<Map<string, FileMeta>> {
    const files =
      listing ?? (await this.#deps.noteFile.listDir(ASSETS_DIR, input.generation).catch(() => []))
    return new Map(files.map((file) => [file.path, file]))
  }

  async #runBackfill(session: GraphSession): Promise<ReconcileAssetDescriptionsOutcome> {
    const { progress, indexLifecycle, logger } = this.#deps
    const { generation, indexGeneration } = session
    const operation = progress.start('Describing assets')
    let outcome: ReconcileAssetDescriptionsOutcome
    try {
      outcome = await this.reconcile({
        generation,
        mode: 'backfill',
        onProgress: (done, total) => operation.progress(done, total),
      })
    } catch (cause) {
      // `reconcile` is contracted not to throw, but finalize the operation
      // defensively so an unexpected failure never strands a "running" entry
      // in the operations UI.
      operation.fail('Failed to describe assets.')
      throw cause
    }
    // Make the new descriptions searchable: re-index the notes that reference the
    // assets we just described (Plan 20 search integration). A failure here must
    // not fail the backfill — the descriptions are written; search folds them on
    // the next re-index or a rebuild.
    if (outcome.describedAssetPaths.length > 0 && indexGeneration !== null) {
      try {
        await indexLifecycle.reindexNotesReferencing(outcome.describedAssetPaths, {
          generation: indexGeneration,
          fileGeneration: generation,
        })
      } catch (cause) {
        logger.warn('asset-description re-index failed:', cause)
      }
      // The re-index wrote search rows directly (not via the watcher → onApplied
      // path), so the index-backed query caches need a refresh for ⌘K to reflect
      // the new descriptions.
      this.#emitDescriptionsIndexed()
    }
    if (outcome.stopped === null || outcome.stopped.reason === 'stale') {
      operation.done()
    } else if (outcome.stopped.reason === 'config') {
      operation.warn('Add an AI provider in Settings to describe assets.')
    } else if (outcome.stopped.reason === 'network') {
      operation.warn('Some assets could not be described — check your connection and try again.')
    } else {
      operation.fail(outcome.stopped.message)
    }
    return outcome
  }
}

export function createAssetDescriptionService(
  deps: AssetDescriptionServiceDeps,
): AssetDescriptionService {
  return new AssetDescriptionServiceImpl(deps)
}
