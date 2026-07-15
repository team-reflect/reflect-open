import { db } from './db'
import { assetReferenceLookupKeys } from './asset-reference-keys'

/**
 * The notes that reference an asset, from the index `assets` projection (Plan
 * 20). Used only to find *candidates* cheaply — the asset-description privacy gate
 * re-reads each candidate's live markdown before trusting it, so an index that
 * lags the watcher can never cause a private note to be missed for long (any
 * reference is written by a note change that itself triggers re-indexing).
 *
 * `assetPath` is the canonical graph-relative managed path, e.g.
 * `assets/diagram.png`. The query includes both that exact candidate and the
 * ASCII-folded basename sentinel emitted for bare wiki embeds; the live gate
 * resolves every returned note against the current attachment catalog.
 */
export async function assetReferencingNotePaths(assetPath: string): Promise<string[]> {
  const keys = assetReferenceLookupKeys(assetPath)
  if (keys.length === 0) {
    return []
  }
  const rows = await db
    .selectFrom('assets')
    .where('assetPath', 'in', keys)
    .select('notePath')
    .distinct()
    .execute()
  return rows.map((row) => row.notePath)
}
