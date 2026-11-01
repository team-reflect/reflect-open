import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { NoteMention, SuggestedBacklink } from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * One link action, with the note and cached list it belongs to.
 */
interface LinkVariables {
  readonly target: string
  readonly listKey: ReturnType<typeof queryKeys.suggestedBacklinks.note>
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
   * True when the query failed and there is nothing to show.
   */
  isError: boolean
  /**
   * Rewrite one mention as a link. The service reports a failed write itself.
   */
  link: (sourcePath: string, mention: NoteMention) => void
  /**
   * True while a link write and its refetch are in flight; the section disables links.
   */
  isLinking: boolean
}

/**
 * The suggested-backlinks data layer: one query per note, fetched when the
 * section mounts — not on index changes, which would re-read up to 100 notes
 * on each save anywhere in the graph. The graph root is in the key, so a graph
 * switch never serves the previous graph's list, and unused entries expire on
 * the default schedule. A mention written elsewhere shows the next time the
 * note is opened. A link
 * that writes drops its source's entries at once; one that is refused
 * re-reads the list, so no entry keeps acting on offsets that have moved.
 *
 * @param path graph-relative path of the note whose mentions to load.
 */
export function useSuggestedBacklinks(path: string): SuggestedBacklinks {
  const { graph } = useGraph()
  const { suggestedBacklinks } = useCoreServices()
  const queryClient = useQueryClient()

  const queryKey = queryKeys.suggestedBacklinks.note(graph?.root, path)
  const { data, isError } = useQuery({
    queryKey,
    queryFn: () => suggestedBacklinks.getSuggestedBacklinks(path),
    enabled: graph !== null,
  })

  // The link carries the list it came from: the sidebar is reused across
  // notes, so by the time a slow write settles the hook may be showing
  // another note, and the outcome belongs to the one that was linked.
  const { mutate, isPending, variables } = useMutation({
    mutationFn: ({ target, sourcePath, mention }: LinkVariables) => {
      return suggestedBacklinks.linkMention(target, sourcePath, mention)
    },
    // The linked source now links to this note, so none of its lines are
    // suggestions any more. Drop them here rather than refetch: a refetch can
    // run before the index has seen the write and bring them straight back.
    // A refetch still in flight read the source before the write; cancel it so
    // it can't put the entries back.
    onSuccess: async (_result, { listKey, sourcePath }) => {
      await queryClient.cancelQueries({ queryKey: listKey })
      queryClient.setQueryData<SuggestedBacklink[]>(listKey, (current) => {
        return current?.filter((entry) => entry.sourcePath !== sourcePath)
      })
    },
    // A refused link means the source moved under the list: re-read it.
    onError: async (_error, { listKey }) => {
      await queryClient.invalidateQueries({ queryKey: listKey })
    },
  })

  return {
    mentions: data ?? [],
    isError: isError && data === undefined,
    link: (sourcePath, mention) => {
      mutate({ target: path, listKey: queryKey, sourcePath, mention })
    },
    isLinking: isPending && variables.target === path,
  }
}
