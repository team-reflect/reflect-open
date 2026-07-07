import { describeAsset, isAssetDescriptionRejected } from '../ai/describe-asset'
import { defaultAiProvider, type AiProvidersState } from '../ai/provider-config'
import { aiKeySecretName } from '../ai/secrets'
import { base64ToBytes } from '../ai/transcribe'
import { errorMessage, isAppError, toAppError } from '../errors'
import { listDir, readAsset, readNote, writeNote } from '../graph/commands'
import { ASSETS_DIR, descriptionPathFor } from '../graph/paths'
import type { FileMeta } from '../graph/schemas'
import { hashContent } from '../indexing/hash'
import { getSecret } from '../secrets/keychain'
import type { AiProviderConfig } from '../settings/schema'
import type { ReconcileStop } from './audio-memo'
import {
  assetTypeFor,
  base64ByteLength,
  buildDescriptionSource,
  isEligibleAssetPath,
  readManagedDescription,
  type ManagedDescription,
} from './asset-description-helpers'
import { classifyAsset } from './asset-privacy'
export {
  assetTypeFor,
  base64ByteLength,
  buildDescriptionSource,
  isEligibleAssetPath,
  readManagedDescription,
  type AssetDescriptionMeta,
  type AssetType,
  type ManagedDescription,
} from './asset-description-helpers'
export { classifyAsset, classifyAssetFromNotes, type AssetVerdict } from './asset-privacy'

/**
 * Asset descriptions (Plan 20). For each eligible image/PDF under `assets/`
 * that is safely associated with public notes, generate a managed markdown
 * description file (`<asset>.reflect.md`) holding an AI description + OCR. The
 * note index is untouched; this only writes files next to the asset.
 *
 * The reconcile pass mirrors `reconcileCaptureEnrichment`: generation-pinned,
 * single-flight (the desktop controller serializes calls), abortable between
 * items via `isStale`, and the retry layer for transient provider failures
 * (auth/network stop the pass; the next trigger re-runs it). Privacy is a hard
 * block — an asset referenced by any private note is never sent.
 */

/** Largest source we send to a provider; bigger assets are skipped, not sent. */
const MAX_ASSET_BYTES = 20 * 1024 * 1024

/** Whether new eligible assets are described automatically vs. only on backfill. */
export type AssetDescriptionMode = 'incremental' | 'backfill'

export interface ReconcileAssetDescriptionsInput {
  /** The configured-providers state — decides the provider and keychain entry. */
  providers: AiProvidersState
  /** `GraphInfo.generation` — pins every read/write to the issuing graph. */
  generation: number
  /** `incremental` processes `changed`; `backfill` enumerates every asset. */
  mode: AssetDescriptionMode
  /** Incremental only: the eligible asset paths the watcher reported changed. */
  changed?: readonly string[]
  /** Host transport for the provider call (the Tauri HTTP plugin's fetch). */
  fetchFn?: typeof fetch
  /** Abort gate, checked between assets and after each slow await. */
  isStale?: () => boolean
  /** Backfill progress: `(processed, total)` after each handled asset. */
  onProgress?: (processed: number, total: number) => void
  /** Injectable clock for the description's `generatedAt`. */
  now?: () => Date
}

export interface ReconcileAssetDescriptionsOutcome {
  /** Eligible assets this pass considered. */
  pending: number
  /** Assets described and written this pass. */
  described: number
  /** Skipped — a managed description already matched the source hash. */
  skippedUpToDate: number
  /** Skipped — referenced by no public note (or none at all). */
  skippedUnreferenced: number
  /** Skipped — referenced by a private note (the hard block). */
  skippedPrivate: number
  /** Skipped — an existing description was user-authored, never overwritten. */
  skippedUserAuthored: number
  /** Skipped — larger than the size cap. */
  skippedOversize: number
  /** Permanent provider refusals — logged, no description written. */
  refused: number
  /**
   * Asset paths for which a description was written this pass. The caller
   * re-indexes the notes referencing them so the new text becomes searchable
   * (`reindexNotesReferencing`).
   */
  describedAssetPaths: string[]
  /** Why the pass ended early, or `null` when every asset was handled. */
  stopped: ReconcileStop | null
}

/** Why an asset was skipped (no description written, nothing sent). */
type AssetSkipReason = 'up-to-date' | 'unreferenced' | 'private' | 'user-authored' | 'oversize' | 'gone'

/** Per-asset result; `stop` ends the whole pass, everything else is a tally. */
type AssetStep =
  | { kind: 'described' }
  | { kind: 'skipped'; reason: AssetSkipReason }
  | { kind: 'refused' }
  | { kind: 'stop'; stopped: ReconcileStop }

/** The mutable counters a pass accumulates; spread verbatim into the outcome. */
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
  fetchFn?: typeof fetch | undefined
  now: () => Date
  isStale: () => boolean
  /** `assets/` file stats (size + mtime), to skip reads we can prove are stale. */
  statByPath: Map<string, FileMeta>
}

const STALE: ReconcileStop = { reason: 'stale', message: 'the graph session ended mid-pass' }

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function utf8FromBase64(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64))
}

async function readDescriptionSource(path: string, generation: number): Promise<string | null> {
  try {
    return await readNote(path, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return null
    }
    throw cause
  }
}

/** Process one asset. Throws on transient (auth/network) failure to stop the pass. */
async function processAsset(assetPath: string, ctx: AssetContext): Promise<AssetStep> {
  const assetType = assetTypeFor(assetPath)
  if (assetType === null) {
    return { kind: 'skipped', reason: 'gone' } // defensive: an ineligible path slipped in
  }

  // Gate first, on the notes index: never read or send an asset's bytes until a
  // non-private note is associated with it (and no private note is). Waiting for
  // the association before attempting keeps private and unreferenced assets
  // entirely untouched — they are never read, hashed, or sent to a provider.
  const verdict = await classifyAsset(assetPath, ctx.generation)
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
  const existing = await readDescriptionSource(descriptionPath, ctx.generation)
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
    base64 = await readAsset(assetPath, ctx.generation)
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

  const sourceHash = await hashContent(base64)
  if (managed !== null && managed.sourceHash === sourceHash) {
    return { kind: 'skipped', reason: 'up-to-date' } // mtime moved but content identical
  }

  if (ctx.isStale()) {
    return { kind: 'stop', stopped: STALE }
  }

  let body: string
  try {
    body = await describeAsset({
      config: ctx.config,
      apiKey: ctx.apiKey,
      fetchFn: ctx.fetchFn,
      kind: assetType.kind,
      mediaType: assetType.mediaType,
      data: assetType.kind === 'svg' ? utf8FromBase64(base64) : base64,
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

  await writeNote(
    descriptionPath,
    buildDescriptionSource(
      {
        source: assetPath,
        sourceHash,
        sourceSize,
        provider: ctx.config.provider,
        model: ctx.config.model,
        generatedAt: ctx.now().toISOString(),
      },
      body,
    ),
    ctx.generation,
  )
  return { kind: 'described' }
}

interface AssetCandidates {
  /** Eligible asset paths to consider this pass. */
  paths: string[]
  /** The `assets/` listing when the mode already fetched it (backfill), else null. */
  listing: FileMeta[] | null
}

async function candidateAssets(input: ReconcileAssetDescriptionsInput): Promise<AssetCandidates> {
  if (input.mode === 'backfill') {
    const listing = await listDir(ASSETS_DIR, input.generation)
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
async function statMap(
  input: ReconcileAssetDescriptionsInput,
  listing: FileMeta[] | null,
): Promise<Map<string, FileMeta>> {
  const files = listing ?? (await listDir(ASSETS_DIR, input.generation).catch(() => []))
  return new Map(files.map((file) => [file.path, file]))
}

/**
 * Describe every candidate asset that needs it. `incremental` mode handles the
 * eligible paths in `changed`; `backfill` mode enumerates every eligible asset
 * under `assets/`. Idempotent in both modes: a managed description whose source
 * hash still matches is skipped, so re-runs are cheap. Never throws.
 */
export async function reconcileAssetDescriptions(
  input: ReconcileAssetDescriptionsInput,
): Promise<ReconcileAssetDescriptionsOutcome> {
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
    candidate = await candidateAssets(input)
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
  const config = defaultAiProvider(input.providers)
  if (config === null) {
    return outcome(total, { reason: 'config', message: 'No AI provider is configured.' })
  }
  const apiKey = await getSecret(aiKeySecretName(config.id)).catch(() => null)
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
    fetchFn: input.fetchFn,
    now: input.now ?? (() => new Date()),
    isStale: () => input.isStale?.() === true,
    statByPath: await statMap(input, candidate.listing),
  }

  let processed = 0
  for (const assetPath of candidate.paths) {
    if (ctx.isStale()) {
      return outcome(total, STALE)
    }
    let step: AssetStep
    try {
      step = await processAsset(assetPath, ctx)
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
