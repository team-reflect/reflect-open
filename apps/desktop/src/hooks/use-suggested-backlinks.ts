import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { NoteMention, SuggestedBacklink } from '@reflect/core'
import { mutationKeys, queryKeys } from '@/lib/query-client.ts'
import { createSuggestedBacklinksQueryOptions } from '@/lib/query-options.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * One link action, with the note it links to.
 */
interface LinkVariables {
  readonly target: string
  readonly sourcePath: string
  readonly mention: NoteMention
}

/**
 * What the suggested-backlinks section needs to render and act.
 */
export interface SuggestedBacklinks {
  /**
   * Mentioning lines, newest source first.
   */
  mentions: SuggestedBacklink[]
  /**
   * True when the last fetch failed, even if an older list is cached.
   */
  isError: boolean
  /**
   * Rewrite one mention as a link. The service reports a failed write itself.
   */
  link: (sourcePath: string, mention: NoteMention) => void
  /**
   * True while any link write and its refetch are in flight, from any section
   * instance; the section disables links.
   */
  isLinking: boolean
}

/**
 * The suggested-backlinks data layer: one query per note, fetched when the
 * section mounts — not on index changes, which would re-read up to 100 notes
 * on each save anywhere in the graph. The graph root is in the key, so a graph
 * switch never serves the previous graph's list, and unused entries expire on
 * the default schedule. A mention written elsewhere shows the next time the
 * note is opened. Every link attempt re-reads the lists on screen and drops
 * the rest, so a linked source drops out and no entry keeps acting on offsets
 * that have moved.
 *
 * @param path graph-relative path of the note whose mentions to load.
 */
export function useSuggestedBacklinks(path: string): SuggestedBacklinks {
  const { graph } = useGraph()
  const { suggestedBacklinks } = useCoreServices()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery({
    ...createSuggestedBacklinksQueryOptions(suggestedBacklinks, graph?.root, path),
    enabled: graph !== null,
  })

  // The link carries the note it links to: the sidebar is reused across
  // notes, so by the time a slow write settles the hook may be showing
  // another one. It is keyed so that a section mounted mid-write (after a
  // daily note or a collapsed sidebar) still sees it in flight.
  const mutationKey = mutationKeys.suggestedBacklinks.link(graph?.root)
  const { mutate } = useMutation({
    mutationKey,
    mutationFn: ({ target, sourcePath, mention }: LinkVariables) => {
      return suggestedBacklinks.linkMention(target, sourcePath, mention)
    },
    // Re-read every list either way: the write changed the source, so any
    // list may hold its old offsets. A written link drops its source from the
    // linked note's list, which the service skips once its current text links
    // here, even before the index catches up; a refused one comes back with
    // fresh offsets. A list nobody shows any more (the user moved to another
    // note, or another graph) is forgotten rather than re-read: the service
    // reads the open graph, and the next mount loads it fresh. Both steps
    // cancel a fetch that read the source before the write.
    onSettled: async () => {
      const queryKey = queryKeys.suggestedBacklinks.all
      queryClient.removeQueries({ queryKey, type: 'inactive' })
      await queryClient.invalidateQueries({ queryKey })
    },
  })
  const isLinking = useIsMutating({ mutationKey }) > 0

  return {
    mentions: data ?? [],
    isError,
    link: (sourcePath, mention) => {
      mutate({ target: path, sourcePath, mention })
    },
    isLinking,
  }
}
