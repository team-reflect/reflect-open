import { z } from 'zod'
import { type AssetKind } from '../ai/describe-asset'
import { ASSETS_DIR, DESCRIPTION_SUFFIX } from '../graph/paths'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'

/** The eligible asset type and how it enters a provider request. */
export interface AssetType {
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

