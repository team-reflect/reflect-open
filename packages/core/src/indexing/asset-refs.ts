import type { MaybePromise } from '@reflect/utils'
import type { XArchiveService } from '../embeds/x-archive-service.ts'
import type { DatabaseService } from './database-service.ts'

/**
 * Does an indexed reference name this file? A bare `![[photo.png]]` is stored
 * as authored because the index cannot know its folder, so it matches any
 * attachment with that filename. Over-matching is the safe direction: it can
 * only make the privacy gate more conservative.
 */
export function assetReferenceMatches(reference: string, assetPath: string): boolean {
  return reference.includes('/')
    ? reference === assetPath
    : reference === (assetPath.split('/').at(-1) ?? assetPath)
}

export interface AssetReferencesDeps {
  readonly database: DatabaseService
  readonly xArchive: XArchiveService
}

/**
 * Which notes reference an asset, from the index `assets` projection.
 */
export interface AssetReferences {
  /**
   * The notes that reference an asset (Plan 20). Used only to find
   * *candidates* cheaply: the asset-description privacy gate re-reads each
   * candidate's live markdown before trusting it, so an index that lags the
   * watcher can never cause a private note to be missed for long (any
   * reference is written by a note change that itself triggers re-indexing).
   *
   * `assetPath` is the canonical graph-relative path, e.g.
   * `assets/diagram.png`. The query matches both that exact spelling and the
   * bare basename a wiki embed stores; {@link assetReferenceMatches}
   * re-applies the same rule to the candidate's live markdown.
   */
  notePaths(assetPath: string, knownOwners?: readonly string[]): MaybePromise<string[]>
}

class AssetReferencesImpl implements AssetReferences {
  readonly #deps: AssetReferencesDeps

  constructor(deps: AssetReferencesDeps) {
    this.#deps = deps
  }

  async notePaths(assetPath: string, knownOwners?: readonly string[]): Promise<string[]> {
    const { database, xArchive } = this.#deps
    const owners = knownOwners ?? (await xArchive.owners(assetPath))
    const basename = assetPath.split('/').at(-1) ?? assetPath
    const rows = await database.db
      .selectFrom('assets')
      .where((eb) =>
        eb.or([
          eb('assetPath', '=', assetPath),
          eb('assetPath', '=', basename),
          ...(owners.length > 0 ? [eb('assetPath', 'in', owners)] : []),
        ]),
      )
      .select('notePath')
      .distinct()
      .execute()
    return rows.map((row) => row.notePath)
  }
}

export function createAssetReferences(deps: AssetReferencesDeps): AssetReferences {
  return new AssetReferencesImpl(deps)
}
