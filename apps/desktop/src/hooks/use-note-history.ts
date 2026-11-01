import { useCallback, useMemo } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { NoteRevision } from '@reflect/core'
import {
  createNoteRevisionTextQueryOptions,
  createNoteRevisionsQueryOptions,
} from '@/lib/query-options.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/** What the history dialog's list needs to render. */
export interface NoteRevisions {
  /** Loaded revisions, newest first. */
  revisions: readonly NoteRevision[]
  /** True while the first page is in flight. */
  isLoading: boolean
  /** The first page failed; there is nothing to show. */
  error: Error | null
  hasNextPage: boolean
  isFetchingNextPage: boolean
  /** The last load of a further page failed; `loadMore` retries it. */
  loadMoreFailed: boolean
  /** Load the next page when one is available and no load is active. */
  loadMore: () => void
}

/**
 * The revisions of the note at `path`, paged newest first. Refetched each
 * time a list mounts: new commits land every few seconds of editing.
 */
export function useNoteRevisions(path: string): NoteRevisions {
  const { graph } = useGraph()
  const { noteHistory } = useCoreServices()
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isPending,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery(createNoteRevisionsQueryOptions(noteHistory, graph?.root, path))
  const revisions = useMemo(() => data?.pages.flatMap((page) => page.revisions) ?? [], [data])
  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) {
      return
    }
    void fetchNextPage({ cancelRefetch: false })
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  return {
    revisions,
    isLoading: isPending,
    error: data === undefined ? error : null,
    hasNextPage,
    isFetchingNextPage,
    loadMoreFailed: isFetchNextPageError,
    loadMore,
  }
}

/**
 * The note's full text at `revision`; `null` selects nothing.
 */
export function useNoteRevisionText(revision: NoteRevision | null): {
  text: string | undefined
  error: Error | null
} {
  const { graph } = useGraph()
  const { noteHistory } = useCoreServices()
  const { data, error } = useQuery(
    createNoteRevisionTextQueryOptions(noteHistory, graph?.root, revision),
  )
  return { text: data, error }
}
