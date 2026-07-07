import { z } from 'zod'
import { classifyAssetFromNotes } from '../../actions/asset-privacy'
import { isAppError } from '../../errors'
import { descriptionPathFor, isAssetPath } from '../../graph/paths'
import { canonicalAssetPath } from '../../markdown/extract'
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
  'Not an asset path — pass assets/… paths exactly as they appear in note markdown.'

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
      'Graph-relative asset paths as they appear in note markdown, e.g. ' +
        `["assets/photo.png"]. Pass every attachment you need in one call, up to ${MAX_READ_ASSETS}.`,
    ),
})

/** The effects {@link buildReadOneAsset} needs, already defaulted by the caller. */
export interface ReadAssetDeps {
  readNoteFn: (path: string) => Promise<string>
  assetReferencingNotePathsFn: (assetPath: string) => Promise<string[]>
}

/**
 * Build the per-asset reader for read_assets: the sidecar body (frontmatter
 * stripped, capped), or a structured per-asset miss/refusal. The model copies
 * paths verbatim from note markdown, so the href is first collapsed to the
 * canonical `assets/…` form the sidecar, index, and privacy gate all key off
 * (`./`-prefixes, percent-escapes). Existence is checked next — a missing
 * sidecar reveals nothing — then the live privacy verdict over the
 * referencing notes (the sidecar on disk can predate a note turning private)
 * gates the mint, failing closed. Once a sidecar exists, the verdict outranks
 * everything else about it — even an empty body answers "unavailable", not
 * "no description", when the asset is blocked.
 */
export function buildReadOneAsset(deps: ReadAssetDeps) {
  return async function readOneAsset(path: string): Promise<ReadAssetResult> {
    const canonical = canonicalAssetPath(path)
    if (canonical === null || !isAssetPath(canonical)) {
      return { ok: false, path, error: NOT_AN_ASSET_ERROR }
    }
    let source: string
    try {
      source = await deps.readNoteFn(descriptionPathFor(canonical))
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return { ok: false, path, error: NO_ASSET_DESCRIPTION_ERROR }
      }
      throw cause
    }
    const body = splitFrontmatter(source).body.trim()
    const candidates = await deps.assetReferencingNotePathsFn(canonical)
    const verdict = await classifyAssetFromNotes(canonical, candidates, deps.readNoteFn)
    const truncated = body.length > MAX_ASSET_DESCRIPTION_CHARS
    try {
      const asset = cloudSafeAssetDescription({
        path: canonical,
        isPrivate: verdict !== 'send',
        description: truncated ? body.slice(0, MAX_ASSET_DESCRIPTION_CHARS) : body,
        truncated,
      })
      if (body === '') {
        // An existing-but-empty sidecar reads as "no description" — but only
        // for a sendable asset; a blocked one threw above, so the two miss
        // messages stay consistent with the privacy contract.
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
}
