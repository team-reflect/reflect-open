import { z } from 'zod'
import {
  isEligibleAssetPath,
  readManagedDescription,
} from '../../actions/asset-description-helpers'
import { classifyAssetBatchFromSnapshot } from '../../actions/asset-privacy'
import type { AssetPrivacySnapshot } from '../../graph/schemas'
import { canonicalAssetPath } from '../../markdown/attachment-reference'
import { splitFrontmatter } from '../../markdown/frontmatter'
import {
  cloudSafeAssetDescription,
  isPrivateNoteError,
  type CloudAssetDescription,
  type CloudSafe,
} from '../checkers'

/**
 * The read_assets tool's executor (Plan 20 meets Plan 10): resolve an
 * `assets/…` path to its stored description sidecar (`<asset>.reflect.md`)
 * and gate it for the provider. The tool registration, name, and transcript
 * unions stay in `./tools` — this module only knows how to read one asset.
 */

/** Cap on assets one read_assets call returns, mirroring `MAX_READ_NOTES`. */
export const MAX_READ_ASSETS = 10

/**
 * Cap on one asset's returned description text — the same bound the indexer
 * puts on a note's folded asset text (`MAX_ASSET_TEXT_CHARS`), so the tool
 * never returns wildly more than search could have matched on.
 */
export const MAX_ASSET_DESCRIPTION_CHARS = 8_000

/** read_assets miss — the sidecar description file doesn't exist (yet). */
export const NO_ASSET_DESCRIPTION_ERROR =
  'No description exists for this asset yet — descriptions are generated in the background.'

/**
 * read_assets refusal for a blocked asset. Deliberately unspecific: naming the
 * private reference would itself reveal that a private note exists, so the
 * private and unreferenced verdicts share one message.
 */
export const ASSET_UNAVAILABLE_ERROR = 'This asset cannot be read by AI.'

/** read_assets refusal for a path that is not an `assets/` attachment. */
export const NOT_AN_ASSET_ERROR =
  'Not an asset path — pass a canonical assets/… path from the graph root.'

/** One asset in a {@link ReadAssetsOutput}: its stored description, or a structured miss/refusal. */
export type ReadAssetResult =
  | { ok: true; asset: CloudSafe<CloudAssetDescription> }
  | { ok: false; path: string; error: string }

/** The read_assets output: one {@link ReadAssetResult} per requested path, in order. */
export interface ReadAssetsOutput {
  assets: ReadAssetResult[]
}

export const readAssetsInput = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_READ_ASSETS)
    .describe(
      'Canonical graph-root managed asset paths, e.g. ["assets/photo.png"]. ' +
        'Normalize a nested note href such as ../assets/photo.png to assets/photo.png. ' +
        `Pass every attachment you need in one call, up to ${MAX_READ_ASSETS}.`,
    ),
})

/** The effects {@link buildReadAssets} needs, already defaulted by the caller. */
export interface ReadAssetDeps {
  privacySnapshotFn: () => Promise<AssetPrivacySnapshot>
  readDescriptionFn: (assetPath: string) => Promise<string | null>
}

/**
 * Read one already-authorized managed description. Classification happens for
 * the complete tool batch before this function is called, so no sidecar body
 * can be observed while the live graph snapshot is still incomplete.
 */
async function readAuthorizedAsset(
  path: string,
  canonical: string,
  readDescriptionFn: (assetPath: string) => Promise<string | null>,
): Promise<ReadAssetResult> {
  let source: string | null
  try {
    source = await readDescriptionFn(canonical)
  } catch {
    return { ok: false, path, error: ASSET_UNAVAILABLE_ERROR }
  }
  if (source === null) {
    return { ok: false, path, error: NO_ASSET_DESCRIPTION_ERROR }
  }
  const managed = readManagedDescription(source)
  if (
    managed === null ||
    (managed.sourcePath !== null && managed.sourcePath !== canonical)
  ) {
    return { ok: false, path, error: NO_ASSET_DESCRIPTION_ERROR }
  }
  const body = splitFrontmatter(source).body.trim()
  const truncated = body.length > MAX_ASSET_DESCRIPTION_CHARS
  try {
    const asset = cloudSafeAssetDescription({
      path: canonical,
      isPrivate: false,
      description: truncated ? body.slice(0, MAX_ASSET_DESCRIPTION_CHARS) : body,
      truncated,
    })
    if (body === '') {
      return { ok: false, path, error: NO_ASSET_DESCRIPTION_ERROR }
    }
    return { ok: true, asset }
  } catch (cause) {
    if (isPrivateNoteError(cause)) {
      return { ok: false, path, error: ASSET_UNAVAILABLE_ERROR }
    }
    throw cause
  }
}

interface AssetRequest {
  readonly path: string
  readonly canonical: string | null
}

/**
 * Build the read_assets batch executor. Every valid requested path is
 * classified from one live note/catalog snapshot before any sidecar is
 * probed. Invalid paths remain per-item input errors; a discovery/read failure
 * makes every managed request generically unavailable.
 */
export function buildReadAssets(
  deps: ReadAssetDeps,
): (paths: readonly string[]) => Promise<ReadAssetsOutput> {
  return async function readAssets(paths: readonly string[]): Promise<ReadAssetsOutput> {
    const requests: AssetRequest[] = paths.map((path) => {
      const canonical = canonicalAssetPath(path)
      return {
        path,
        canonical:
          canonical !== null && isEligibleAssetPath(canonical) ? canonical : null,
      }
    })
    const canonicalPaths = requests.flatMap((request) =>
      request.canonical === null ? [] : [request.canonical],
    )
    let verdicts: ReturnType<typeof classifyAssetBatchFromSnapshot>
    if (canonicalPaths.length === 0) {
      verdicts = new Map()
    } else {
      try {
        verdicts = classifyAssetBatchFromSnapshot(
          canonicalPaths,
          await deps.privacySnapshotFn(),
        )
      } catch {
        verdicts = new Map(canonicalPaths.map((path) => [path, 'skip-private' as const]))
      }
    }

    return {
      assets: await Promise.all(
        requests.map(async (request): Promise<ReadAssetResult> => {
          if (request.canonical === null) {
            return { ok: false, path: request.path, error: NOT_AN_ASSET_ERROR }
          }
          if (verdicts.get(request.canonical) !== 'send') {
            return { ok: false, path: request.path, error: ASSET_UNAVAILABLE_ERROR }
          }
          return readAuthorizedAsset(request.path, request.canonical, deps.readDescriptionFn)
        }),
      ),
    }
  }
}
