import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { hasBridge, isDaily, relatedNotes, type RetrievalHit } from '@reflect/core'
import { readNoteSource } from '@/lib/note-frontmatter'
import { isOstensiblyEmptyNoteSource } from '@/lib/note-emptiness'
import { INDEX_QUERY_SCOPE, SIMILAR_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

const SIMILAR_NOTES_LIMIT = 6

/**
 * The note's semantic neighbors ("Similar notes"), one query shared by every
 * surface that shows them (the in-note panel and the context sidebars). The
 * graph root is part of the key because cached rows must never outlive a graph
 * switch.
 *
 * Neighbors are computed **once per note per session**, not on the index
 * invalidation scope: the lookup is up to seventeen vector KNN queries, and
 * under that scope it re-ran every few seconds through any burst of graph
 * activity — a sync, a backfill, your own typing — for a panel of six titles
 * that barely moves. It also re-ran at the wrong moment. `onApplied` fires
 * *before* the embedding sync has written the save's new vectors, so those
 * refetches read the previous generation anyway; the cost bought no freshness.
 * The trade is deliberate: neighbors reflect the note as it was embedded when
 * you opened it, and a reopen picks up anything later.
 *
 * The daily-note emptiness gate below is the exception that stays index-scoped
 * — it must reopen the gate when a blank daily gets its first line — and an
 * empty *result* is left stale so a note whose vectors land later (a fresh
 * note, a backfill still running) fills in on its next mount instead of being
 * frozen at "no neighbors" for the session. The gate closing works the other
 * way too: a daily observed empty has had its content *wiped*, so its cached
 * neighbors describe deleted text — they're dropped, and the refill recomputes
 * instead of being served the old note's panel from cache.
 *
 * Gated on `semanticSearchEnabled` so disabling semantic search empties every
 * surface immediately: the query stops fetching, and the cached rows are
 * masked too — a disabled query still reports its last data, and stored
 * vectors would otherwise keep answering for the rest of the session.
 */
export function useSimilarNotes(path: string): RetrievalHit[] {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const queryClient = useQueryClient()
  const bridgeAvailable = hasBridge()
  const dailyNote = isDaily(path)
  const { data: dailyNoteIsEmpty } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'daily-empty', path],
    queryFn: async () => isOstensiblyEmptyNoteSource(await readNoteSource(path)),
    enabled: bridgeAvailable && graph !== null && dailyNote && settings.semanticSearchEnabled,
  })
  const graphRoot = graph?.root
  // A daily observed empty was cleared: its cached neighbors (frozen at
  // `staleTime: Infinity` below) describe the deleted content, and re-enabling
  // the query on refill would serve them straight from cache. Dropping the
  // entry makes the refill compute fresh. Safe to run repeatedly — the query
  // is disabled while the gate is closed, so there's no in-flight fetch.
  useEffect(() => {
    if (dailyNoteIsEmpty === true) {
      queryClient.removeQueries({
        queryKey: [SIMILAR_QUERY_SCOPE, graphRoot, path],
        exact: true,
      })
    }
  }, [dailyNoteIsEmpty, queryClient, graphRoot, path])
  const enabled =
    bridgeAvailable &&
    graph !== null &&
    settings.semanticSearchEnabled &&
    (!dailyNote || dailyNoteIsEmpty === false)
  const { data } = useQuery({
    queryKey: [SIMILAR_QUERY_SCOPE, graph?.root, path],
    queryFn: () => relatedNotes(path, SIMILAR_NOTES_LIMIT),
    enabled,
    staleTime: (query) => ((query.state.data?.length ?? 0) > 0 ? Infinity : 0),
    // Held for the session so revisiting a note is free; dropped wholesale on
    // a graph switch (dropSimilarNotesQueries).
    gcTime: Infinity,
  })
  // Slice off the query result (reference-stable via structural sharing) only
  // when it or the gate changes, so consumers get a stable array across the
  // sidebar's frequent re-renders instead of a fresh one every call.
  return useMemo(() => (enabled ? (data ?? []).slice(0, SIMILAR_NOTES_LIMIT) : []), [data, enabled])
}
