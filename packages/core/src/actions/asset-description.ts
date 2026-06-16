import { Document, parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { pickAssetDescriptionConfig, type AiProvidersState } from '../ai/provider-config'
import { aiKeySecretName } from '../ai/secrets'
import {
  describeAsset,
  isAssetDescriptionRejected,
  type DescribeAssetRequest,
} from '../ai/describe-asset'
import { errorMessage, isAppError, toAppError, type AppError } from '../errors'
import { ASSETS_DIR } from '../graph/paths'
import { listDir, listFiles, readAsset, readNote, writeNote } from '../graph/commands'
import type { FileMeta } from '../graph/schemas'
import { emitFileChanges } from '../indexing/file-changes'
import { parseNote } from '../markdown/extract'
import { splitFrontmatter } from '../markdown/frontmatter'
import { getSecret } from '../secrets/keychain'
import { base64ToBytes } from '../ai/transcribe'

/**
 * Asset description sidecars: AI-generated markdown stored beside images/PDFs
 * under `assets/`. Search indexes the managed sidecar text separately through
 * the notes that publicly reference the source asset.
 */

const SIDECAR_SUFFIX = '.reflect.md'
const SUPPORTED_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

const sidecarFrontmatterSchema = z.object({
  reflectAssetDescription: z.literal(1),
  source: z.string(),
  sourceHash: z.string(),
  sourceSize: z.number(),
  provider: z.string(),
  model: z.string(),
  generatedAt: z.string(),
})

export type AssetDescriptionSidecarMeta = z.infer<typeof sidecarFrontmatterSchema>

export interface AssetDescriptionCandidate {
  path: string
  mediaType: string
  sourceSize: number | null
}

export type AssetDescriptionSkipReason =
  | 'unsupported'
  | 'unreferenced'
  | 'private'
  | 'unmanagedSidecar'
  | 'fresh'
  | 'rejected'

export interface ReconcileStop {
  reason: 'config' | 'stale' | AppError['kind']
  message: string
}

export interface ReconcileAssetDescriptionsInput {
  /** Configured provider state — decides the provider and keychain entry. */
  providers: AiProvidersState
  /** `GraphInfo.generation` — pins every graph read/write to the session. */
  generation: number
  /** Specific assets to consider. Omit only for explicit manual backfill. */
  assetPaths?: string[]
  /** Host transport for the provider call. */
  fetchFn?: typeof fetch | undefined
  /** Abort gate, checked between assets and after slow awaits. */
  isStale?: () => boolean
  /** Abort signal passed into the provider call. */
  signal?: AbortSignal | undefined
  /** Progress over the candidate set. */
  onProgress?: (progress: { done: number; total: number; path: string | null }) => void
}

export interface ReconcileAssetDescriptionsOutcome {
  considered: number
  described: number
  skipped: Record<AssetDescriptionSkipReason, number>
  stopped: ReconcileStop | null
}

/** Graph-relative markdown sidecar path for a source asset path. */
export function assetDescriptionSidecarPath(assetPath: string): string {
  return `${assetPath}${SIDECAR_SUFFIX}`
}

/** Source asset path for a generated sidecar path, or null when it is not one. */
export function assetPathFromDescriptionSidecar(path: string): string | null {
  if (!path.startsWith(`${ASSETS_DIR}/`) || !path.endsWith(SIDECAR_SUFFIX)) {
    return null
  }
  const assetPath = path.slice(0, -SIDECAR_SUFFIX.length)
  return isDescribableAssetPath(assetPath) ? assetPath : null
}

/** True for an image/PDF source asset that v1 can send to the provider. */
export function isDescribableAssetPath(path: string): boolean {
  if (!path.startsWith(`${ASSETS_DIR}/`) || path.endsWith(SIDECAR_SUFFIX)) {
    return false
  }
  return mediaTypeForAsset(path) !== null
}

/** MIME type for a supported source asset, or null. */
export function mediaTypeForAsset(path: string): string | null {
  const extension = path.split('.').at(-1)?.toLowerCase()
  return extension ? (SUPPORTED_MIME_BY_EXTENSION[extension] ?? null) : null
}

/** Parse Reflect-managed sidecar metadata, returning null for unmanaged files. */
export function parseAssetDescriptionSidecarMeta(
  source: string,
): AssetDescriptionSidecarMeta | null {
  const { raw } = splitFrontmatter(source)
  if (raw === null) {
    return null
  }
  let loaded: unknown
  try {
    loaded = parseYaml(raw)
  } catch {
    return null
  }
  const parsed = sidecarFrontmatterSchema.safeParse(loaded)
  return parsed.success ? parsed.data : null
}

/** Whether a sidecar can be written for this asset/hash pair. */
export async function assetDescriptionPending(input: {
  assetPath: string
  sourceHash: string
  generation: number
}): Promise<'pending' | 'fresh' | 'unmanagedSidecar'> {
  try {
    const source = await readNote(assetDescriptionSidecarPath(input.assetPath), input.generation)
    const meta = parseAssetDescriptionSidecarMeta(source)
    if (meta === null || meta.source !== input.assetPath) {
      return 'unmanagedSidecar'
    }
    return meta.sourceHash === input.sourceHash ? 'fresh' : 'pending'
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return 'pending'
    }
    throw cause
  }
}

/** List supported source assets. Used only by explicit manual backfill. */
export async function listDescribableAssets(
  generation: number,
): Promise<AssetDescriptionCandidate[]> {
  const files = await listDir(ASSETS_DIR, generation)
  return files.flatMap(candidateFromFile)
}

function candidateFromFile(file: FileMeta): AssetDescriptionCandidate[] {
  const mediaType = mediaTypeForAsset(file.path)
  return mediaType && isDescribableAssetPath(file.path)
    ? [{ path: file.path, mediaType, sourceSize: file.size }]
    : []
}

function candidateFromPath(path: string): AssetDescriptionCandidate | null {
  const mediaType = mediaTypeForAsset(path)
  return mediaType && isDescribableAssetPath(path) ? { path, mediaType, sourceSize: null } : null
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function sidecarMarkdown(input: {
  assetPath: string
  sourceHash: string
  sourceSize: number
  provider: string
  model: string
  body: string
}): string {
  const doc = new Document({
    reflectAssetDescription: 1,
    source: input.assetPath,
    sourceHash: input.sourceHash,
    sourceSize: input.sourceSize,
    provider: input.provider,
    model: input.model,
    generatedAt: new Date().toISOString(),
  })
  const body = input.body.trim() || 'No description returned.'
  return `---\n${String(doc)}---\n\n# Asset description\n\n${body}\n`
}

interface AssetReferenceState {
  publicAssets: Set<string>
  privateAssets: Set<string>
}

async function buildAssetReferenceState(generation: number): Promise<AssetReferenceState> {
  const notes = await listFiles(generation)
  const publicAssets = new Set<string>()
  const privateAssets = new Set<string>()
  for (const file of notes) {
    const source = await readNote(file.path, generation)
    const parsed = parseNote({ path: file.path, source })
    const target = parsed.frontmatter.private ? privateAssets : publicAssets
    for (const asset of parsed.assets) {
      if (isDescribableAssetPath(asset.path)) {
        target.add(asset.path)
      }
    }
  }
  return { publicAssets, privateAssets }
}

function eligible(
  referenceState: AssetReferenceState,
  path: string,
): 'eligible' | 'private' | 'unreferenced' {
  if (referenceState.privateAssets.has(path)) {
    return 'private'
  }
  return referenceState.publicAssets.has(path) ? 'eligible' : 'unreferenced'
}

function emptySkipped(): Record<AssetDescriptionSkipReason, number> {
  return {
    unsupported: 0,
    unreferenced: 0,
    private: 0,
    unmanagedSidecar: 0,
    fresh: 0,
    rejected: 0,
  }
}

function uniqueCandidates(candidates: AssetDescriptionCandidate[]): AssetDescriptionCandidate[] {
  const seen = new Set<string>()
  const unique: AssetDescriptionCandidate[] = []
  for (const candidate of candidates) {
    if (!seen.has(candidate.path)) {
      seen.add(candidate.path)
      unique.push(candidate)
    }
  }
  return unique.sort((left, right) => left.path.localeCompare(right.path))
}

function stopped(
  considered: number,
  described: number,
  skipped: Record<AssetDescriptionSkipReason, number>,
  cause: unknown,
): ReconcileAssetDescriptionsOutcome {
  return {
    considered,
    described,
    skipped,
    stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
  }
}

/**
 * Describe eligible assets and write managed markdown sidecars. When
 * `assetPaths` is omitted this performs an explicit whole-graph backfill; the
 * automatic lifecycle must pass specific paths so existing assets are not
 * processed by surprise.
 */
export async function reconcileAssetDescriptions(
  input: ReconcileAssetDescriptionsInput,
): Promise<ReconcileAssetDescriptionsOutcome> {
  const skipped = emptySkipped()
  let described = 0
  let candidates: AssetDescriptionCandidate[]
  try {
    candidates = input.assetPaths
      ? input.assetPaths.flatMap((path) => {
          const candidate = candidateFromPath(path)
          if (candidate === null) {
            skipped.unsupported += 1
            return []
          }
          return [candidate]
        })
      : await listDescribableAssets(input.generation)
    candidates = uniqueCandidates(candidates)
  } catch (cause) {
    return stopped(0, 0, skipped, cause)
  }

  const considered = candidates.length
  input.onProgress?.({ done: 0, total: considered, path: null })
  if (considered === 0) {
    return { considered, described, skipped, stopped: null }
  }

  const config = pickAssetDescriptionConfig(input.providers)
  if (config === null) {
    return {
      considered,
      described,
      skipped,
      stopped: { reason: 'config', message: 'No AI provider is configured.' },
    }
  }
  const apiKey = await getSecret(aiKeySecretName(config.id)).catch(() => null)
  if (apiKey === null) {
    return {
      considered,
      described,
      skipped,
      stopped: {
        reason: 'config',
        message: `The API key for the configured ${config.provider} model is missing from the keychain.`,
      },
    }
  }

  let referenceState: AssetReferenceState
  try {
    referenceState = await buildAssetReferenceState(input.generation)
  } catch (cause) {
    return stopped(considered, described, skipped, cause)
  }

  const stale = (): boolean => input.isStale?.() === true
  const stalled = (): ReconcileAssetDescriptionsOutcome => ({
    considered,
    described,
    skipped,
    stopped: { reason: 'stale', message: 'the graph session ended mid-pass' },
  })

  let done = 0
  for (const candidate of candidates) {
    if (stale()) {
      return stalled()
    }
    try {
      const eligibility = eligible(referenceState, candidate.path)
      if (eligibility !== 'eligible') {
        skipped[eligibility] += 1
        done += 1
        input.onProgress?.({ done, total: considered, path: candidate.path })
        continue
      }

      const bytesBase64 = await readAsset(candidate.path, input.generation)
      const bytes = base64ToBytes(bytesBase64)
      const sourceHash = await hashBytes(bytes)
      const pending = await assetDescriptionPending({
        assetPath: candidate.path,
        sourceHash,
        generation: input.generation,
      })
      if (pending !== 'pending') {
        skipped[pending] += 1
        done += 1
        input.onProgress?.({ done, total: considered, path: candidate.path })
        continue
      }
      if (stale()) {
        return stalled()
      }

      const body = await describeAsset({
        config,
        apiKey,
        fetchFn: input.fetchFn,
        path: candidate.path,
        contentsBase64: bytesBase64,
        mediaType: candidate.mediaType,
        signal: input.signal,
      } satisfies DescribeAssetRequest)
      if (stale()) {
        return stalled()
      }
      const sidecarPath = assetDescriptionSidecarPath(candidate.path)
      await writeNote(
        sidecarPath,
        sidecarMarkdown({
          assetPath: candidate.path,
          sourceHash,
          sourceSize: candidate.sourceSize ?? bytes.length,
          provider: config.provider,
          model: config.model,
          body,
        }),
        input.generation,
      )
      emitFileChanges([{ path: sidecarPath, kind: 'upsert', modifiedMs: Date.now() }])
      described += 1
    } catch (cause) {
      if (isAssetDescriptionRejected(cause)) {
        console.error(`asset description rejected for ${candidate.path}:`, cause)
        skipped.rejected += 1
        done += 1
        input.onProgress?.({ done, total: considered, path: candidate.path })
        continue
      }
      return stopped(considered, described, skipped, cause)
    }
    done += 1
    input.onProgress?.({ done, total: considered, path: candidate.path })
  }
  return { considered, described, skipped, stopped: null }
}
