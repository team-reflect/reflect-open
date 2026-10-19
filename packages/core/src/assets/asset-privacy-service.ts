import { isAppError } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { assetReferenceMatches, type AssetReferences } from '../indexing/asset-refs.ts'
import { parseNote } from '../markdown/extract.ts'
import type { XArchiveService } from '../embeds/x-archive-service.ts'

/**
 * Outcome of the privacy gate for one asset.
 */
export type AssetVerdict = 'send' | 'skip-unreferenced' | 'skip-private'

/**
 * The asset privacy verdict both asset-description consumers share: the
 * generation pass (`AssetDescriptionService`) decides whether an asset's
 * bytes may be sent to a provider, and the chat read_assets tool decides
 * whether its stored description may be — the sidecar on disk can predate a
 * note turning private, so the read path re-runs the same verdict live.
 *
 * The contract: sendable only when the asset is referenced by ≥1 non-private
 * note and by **0** private notes. Candidates come from the index, but the
 * verdict is made from each candidate's live markdown, failing closed.
 */
export interface AssetPrivacyService {
  /**
   * Decide whether an asset may be sent: referenced by ≥1 non-private note and by
   * **0** private notes (unreferenced → skip). Candidate notes come from the
   * index, but the verdict is made from each candidate's **live** markdown — the
   * private flag and a re-confirmation that the body still references the asset.
   * Fails closed: an unreadable candidate blocks the asset.
   */
  classifyAsset(assetPath: string, generation: number): Promise<AssetVerdict>
  /**
   * The verdict core of {@link AssetPrivacyService.classifyAsset}, over an
   * explicit candidate list and note reader. The chat tools reuse it with
   * unpinned reads and an injectable candidate query; the description pass
   * wraps it with generation-pinned reads.
   */
  classifyAssetFromNotes(
    assetPath: string,
    candidates: readonly string[],
    readSource: (notePath: string) => Promise<string>,
    knownOwners?: readonly string[],
  ): Promise<AssetVerdict>
}

export interface AssetPrivacyServiceDeps {
  readonly noteFile: NoteFileService
  readonly xArchive: XArchiveService
  readonly assetReferences: AssetReferences
}

class AssetPrivacyServiceImpl implements AssetPrivacyService {
  readonly #deps: AssetPrivacyServiceDeps

  constructor(deps: AssetPrivacyServiceDeps) {
    this.#deps = deps
  }

  async classifyAsset(assetPath: string, generation: number): Promise<AssetVerdict> {
    const { noteFile, xArchive, assetReferences } = this.#deps
    const owners = await xArchive.owners(assetPath, generation)
    const candidates = await assetReferences.notePaths(assetPath, owners)
    return await this.classifyAssetFromNotes(
      assetPath,
      candidates,
      (notePath) => noteFile.read(notePath, generation),
      owners,
    )
  }

  async classifyAssetFromNotes(
    assetPath: string,
    candidates: readonly string[],
    readSource: (notePath: string) => Promise<string>,
    knownOwners?: readonly string[],
  ): Promise<AssetVerdict> {
    if (candidates.length === 0) {
      return 'skip-unreferenced'
    }
    const owners = knownOwners ?? (await this.#deps.xArchive.owners(assetPath))
    const references = [assetPath, ...owners]
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
      if (
        !parsed.assets.some((ref) => {
          return references.some((path) => assetReferenceMatches(ref.path, path))
        })
      ) {
        continue
      }
      if (parsed.frontmatter.private) {
        return 'skip-private'
      }
      publicRefs += 1
    }
    return publicRefs > 0 ? 'send' : 'skip-unreferenced'
  }
}

export function createAssetPrivacyService(deps: AssetPrivacyServiceDeps): AssetPrivacyService {
  return new AssetPrivacyServiceImpl(deps)
}
