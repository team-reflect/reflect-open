import { db } from './db'

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

/**
 * The notes that reference an asset, from the index `assets` projection (Plan
 * 20). Used only to find *candidates* cheaply — the asset-description privacy gate
 * re-reads each candidate's live markdown before trusting it, so an index that
 * lags the watcher can never cause a private note to be missed for long (any
 * reference is written by a note change that itself triggers re-indexing).
 *
 * `assetPath` is the canonical graph-relative path, e.g. `assets/diagram.png`.
 * The query matches both that exact spelling and the bare basename a wiki
 * embed stores; {@link assetReferenceMatches} re-applies the same rule to the
 * candidate's live markdown.
 */
export async function assetReferencingNotePaths(assetPath: string): Promise<string[]> {
  const basename = assetPath.split('/').at(-1) ?? assetPath
  const rows = await db
    .selectFrom('assets')
    .where((eb) => eb.or([eb('assetPath', '=', assetPath), eb('assetPath', '=', basename)]))
    .select('notePath')
    .distinct()
    .execute()
  return rows.map((row) => row.notePath)
}
