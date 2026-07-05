import type { BacklinkContext } from '@reflect/core'

/** One referencing note: its identity plus every linking line found in it. */
export interface BacklinkSource {
  /** Graph-relative path of the source note (the navigation target). */
  path: string
  /** Title of the source note. */
  title: string
  /** The line around each link, keyed `path:posFrom` for stable rendering. */
  snippets: Array<{ key: string; text: string }>
}

/**
 * Group flat backlink rows by their source note, preserving the query's
 * most-recent-source-first order (V1 parity). Empty snippets (a source that
 * vanished between the index query and the file read) are dropped, but the
 * source group itself still renders so the reference stays discoverable.
 */
export function groupBacklinksBySource(
  backlinks: readonly BacklinkContext[],
): BacklinkSource[] {
  const groups = new Map<string, BacklinkSource>()
  for (const backlink of backlinks) {
    let group = groups.get(backlink.sourcePath)
    if (group === undefined) {
      group = { path: backlink.sourcePath, title: backlink.sourceTitle, snippets: [] }
      groups.set(backlink.sourcePath, group)
    }
    if (backlink.snippet !== '') {
      group.snippets.push({
        key: `${backlink.sourcePath}:${backlink.posFrom}`,
        text: backlink.snippet,
      })
    }
  }
  return [...groups.values()]
}
