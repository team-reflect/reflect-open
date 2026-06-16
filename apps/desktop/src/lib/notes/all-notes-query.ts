import { foldTag } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'

/**
 * The TanStack Query keys for the All Notes screen, in one place so the screen's
 * `useQuery` and the bulk-trash hook's optimistic patch can't drift apart.
 *
 * The list key carries the folded tag (matching the SQL filter, so `#Book` and
 * `#book` share a cache entry). The trash hook patches every list variant at
 * once via the `[INDEX_QUERY_SCOPE, root, 'all-notes']` prefix — a trashed note
 * leaves every tag view, not just the active one — which {@link allNotesListPrefix}
 * exposes. That prefix does *not* match the tags-facet key, whose third element
 * is the distinct string `'all-notes-tags'`, so facet counts reconcile via the
 * watcher rather than the optimistic patch.
 */
const ALL_NOTES = 'all-notes'
const ALL_NOTES_TAGS = 'all-notes-tags'

/** The list query key for one tag filter (`null` = all non-daily notes). */
export function allNotesQueryKey(
  root: string | undefined,
  tag: string | null,
): [string, string | undefined, string, string | null] {
  return [INDEX_QUERY_SCOPE, root, ALL_NOTES, tag === null ? null : foldTag(tag)]
}

/** The shared prefix of every All Notes list variant — for bulk cache patches. */
export function allNotesListPrefix(root: string | undefined): [string, string | undefined, string] {
  return [INDEX_QUERY_SCOPE, root, ALL_NOTES]
}

/** The tag-facet query key (the Custom filter menu's tag list + counts). */
export function allNotesTagsQueryKey(
  root: string | undefined,
): [string, string | undefined, string] {
  return [INDEX_QUERY_SCOPE, root, ALL_NOTES_TAGS]
}
