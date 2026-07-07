import { isAppError } from '../errors'
import { readNote } from '../graph/commands'
import { assetReferencingNotePaths } from '../indexing/asset-refs'
import { parseNote } from '../markdown/extract'

/**
 * The asset privacy verdict both asset-description consumers share: the
 * generation pass (`reconcileAssetDescriptions`) decides whether an asset's
 * bytes may be sent to a provider, and the chat read_assets tool decides
 * whether its stored description may be — the sidecar on disk can predate a
 * note turning private, so the read path re-runs the same verdict live.
 *
 * The contract: sendable only when the asset is referenced by ≥1 non-private
 * note and by **0** private notes. Candidates come from the index, but the
 * verdict is made from each candidate's live markdown, failing closed.
 */

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
  return classifyAssetFromNotes(assetPath, candidates, (notePath) => readNote(notePath, generation))
}

/**
 * The verdict core of {@link classifyAsset}, over an explicit candidate list
 * and note reader. The chat tools reuse it with unpinned reads and an
 * injectable candidate query; the description pass wraps it with
 * generation-pinned reads.
 */
export async function classifyAssetFromNotes(
  assetPath: string,
  candidates: readonly string[],
  readSource: (notePath: string) => Promise<string>,
): Promise<AssetVerdict> {
  if (candidates.length === 0) {
    return 'skip-unreferenced'
  }
  let publicRefs = 0
  for (const notePath of candidates) {
    let source: string
    try {
      source = await readSource(notePath)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        continue
      }
      return 'skip-private'
    }
    const parsed = parseNote({ path: notePath, source })
    if (!parsed.assets.some((ref) => ref.path === assetPath)) {
      continue
    }
    if (parsed.frontmatter.private) {
      return 'skip-private'
    }
    publicRefs += 1
  }
  return publicRefs > 0 ? 'send' : 'skip-unreferenced'
}
