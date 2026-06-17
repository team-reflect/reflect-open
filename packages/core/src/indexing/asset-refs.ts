import { db } from './db'

/**
 * The notes that reference an asset, from the index `assets` projection (Plan
 * 20). Used only to find *candidates* cheaply — the asset-description privacy gate
 * re-reads each candidate's live markdown before trusting it, so an index that
 * lags the watcher can never cause a private note to be missed for long (any
 * reference is written by a note change that itself triggers re-indexing).
 *
 * `assetPath` is the graph-relative href as stored at index time
 * (`buildIndexedNote`), e.g. `assets/diagram.png`.
 */
export async function assetReferencingNotePaths(assetPath: string): Promise<string[]> {
  const rows = await db
    .selectFrom('assets')
    .where('assetPath', '=', assetPath)
    .select('notePath')
    .distinct()
    .execute()
  return rows.map((row) => row.notePath)
}
