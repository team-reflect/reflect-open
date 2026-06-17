import { z } from 'zod'
import { describeAsset, isAssetDescriptionRejected, type AssetKind } from '../ai/describe-asset'
import { defaultAiProvider, type AiProvidersState } from '../ai/provider-config'
import { aiKeySecretName } from '../ai/secrets'
import { base64ToBytes } from '../ai/transcribe'
import { errorMessage, isAppError, toAppError } from '../errors'
import { listDir, readAsset, readNote, writeNote } from '../graph/commands'
import { ASSETS_DIR, DESCRIPTION_SUFFIX, descriptionPathFor } from '../graph/paths'
import type { FileMeta } from '../graph/schemas'
import { assetReferencingNotePaths } from '../indexing/asset-refs'
import { hashContent } from '../indexing/hash'
import { parseNote } from '../markdown/extract'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import { getSecret } from '../secrets/keychain'
import type { AiProviderConfig } from '../settings/schema'
import type { ReconcileStop } from './audio-memo'

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

/** The eligible asset types and how each enters a provider request. */
interface AssetType {
  kind: AssetKind
  mediaType: string
}

const ASSET_TYPES: Readonly<Record<string, AssetType>> = {
  png: { kind: 'image', mediaType: 'image/png' },
  jpg: { kind: 'image', mediaType: 'image/jpeg' },
  jpeg: { kind: 'image', mediaType: 'image/jpeg' },
  gif: { kind: 'image', mediaType: 'image/gif' },
  webp: { kind: 'image', mediaType: 'image/webp' },
  svg: { kind: 'svg', mediaType: 'image/svg+xml' },
  pdf: { kind: 'pdf', mediaType: 'application/pdf' },
}

/**
 * The asset type for a graph-relative path, or `null` when it is not an
 * eligible asset: outside `assets/`, a description itself, or an unsupported
 * extension. Pure — the watcher's Rust filter mirrors this rule.
 */
export function assetTypeFor(path: string): AssetType | null {
  if (!path.startsWith(`${ASSETS_DIR}/`) || path.endsWith(DESCRIPTION_SUFFIX)) {
    return null
  }
  const dot = path.lastIndexOf('.')
  if (dot < 0) {
    return null
  }
  return ASSET_TYPES[path.slice(dot + 1).toLowerCase()] ?? null
}

/** Whether a graph-relative path is an asset this feature describes. */
export function isEligibleAssetPath(path: string): boolean {
  return assetTypeFor(path) !== null
}

/** Provenance recorded in a managed description's frontmatter. */
export interface AssetDescriptionMeta {
  /** The graph-relative source asset path. */
  source: string
  /** sha256 of the source bytes (as base64) — the change-detection key. */
  sourceHash: string
  /** Source size in bytes. */
  sourceSize: number
  /** The provider the description was generated with. */
  provider: string
  /** The model id. */
  model: string
  /** ISO-8601 generation timestamp. */
  generatedAt: string
}

/** The managed marker; its presence means Reflect owns the file. */
const managedDescriptionSchema = z.object({
  reflectAsset: z.literal(true),
  sourceHash: z.string().optional(),
  sourceSize: z.number().optional(),
  generatedAt: z.string().optional(),
})

/** A managed description's identity, as read back from disk. */
export interface ManagedDescription {
  /** The recorded source hash, or `null` if absent (forces a rewrite). */
  sourceHash: string | null
  /** The recorded source size in bytes, or `null` if absent. */
  sourceSize: number | null
  /** `generatedAt` parsed to epoch ms, or `null` if absent/unparseable. */
  generatedAtMs: number | null
}

/**
 * Read a description's managed marker. `null` means the file is **user-authored**
 * (no `reflectAsset: true`) and must never be overwritten or trusted.
 */
export function readManagedDescription(source: string): ManagedDescription | null {
  const parsed = managedDescriptionSchema.safeParse(parseFrontmatter(splitFrontmatter(source).raw).data)
  if (!parsed.success) {
    return null
  }
  const generatedAtMs = parsed.data.generatedAt ? Date.parse(parsed.data.generatedAt) : Number.NaN
  return {
    sourceHash: parsed.data.sourceHash ?? null,
    sourceSize: parsed.data.sourceSize ?? null,
    generatedAtMs: Number.isNaN(generatedAtMs) ? null : generatedAtMs,
  }
}

/** Assemble a managed description's full source from its provenance + body. */
export function buildDescriptionSource(meta: AssetDescriptionMeta, body: string): string {
  return upsertFrontmatter(`${body.trimEnd()}\n`, {
    reflectAsset: true,
    source: meta.source,
    sourceHash: meta.sourceHash,
    sourceSize: meta.sourceSize,
    provider: meta.provider,
    model: meta.model,
    generatedAt: meta.generatedAt,
  })
}

/** Decoded byte length of a base64 payload, without materializing the bytes. */
export function base64ByteLength(base64: string): number {
  const length = base64.length
  if (length === 0) {
    return 0
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((length * 3) / 4) - padding
}

/** Outcome of the privacy gate for one asset. */
export type AssetVerdict = 'send' | 'skip-unreferenced' | 'skip-private'

/**
 * Decide whether an asset may be sent: referenced by ≥1 non-private note and by
 * **0** private notes (unreferenced → skip). Candidate notes come from the
 * index, but the verdict is made from each candidate's **live** markdown — the
 * private flag and a re-confirmation that the body still references the asset.
 * Fails closed: an unreadable candidate blocks the asset.
 */
export async function classifyAsset(assetPath: string, generation: number): Promise<AssetVerdict> {
  const candidates = await assetReferencingNotePaths(assetPath)
  if (candidates.length === 0) {
    return 'skip-unreferenced'
  }
  let publicRefs = 0
  for (const notePath of candidates) {
    let source: string
    try {
      source = await readNote(notePath, generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        continue // removed since the index recorded it — not a live referer
      }
      return 'skip-private' // unreadable: cannot clear it, so fail closed
    }
    const parsed = parseNote({ path: notePath, source })
    if (!parsed.assets.some((ref) => ref.path === assetPath)) {
      continue // the index lagged the live body — no longer a referer
    }
    if (parsed.frontmatter.private) {
      return 'skip-private' // the hard block
    }
    publicRefs += 1
  }
  return publicRefs > 0 ? 'send' : 'skip-unreferenced'
}

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
    return { paths: listing.map((file) => file.path).filter(isEligibleAssetPath), listing }
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
