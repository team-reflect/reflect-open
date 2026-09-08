import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getPinnedNotes, type PinnedNote } from '@reflect/core'
import {
  pinOverlays,
  reconcilePinOverlays,
  useNoteRowOverlayRevision,
} from '@/hooks/note-row-overlay'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { withPinOverlays } from '@/lib/notes/pinned-shelf-overlay'
import { queryKeys } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/** A stable empty list, so the memos below don't recompute on every render. */
const NONE: PinnedNote[] = []

/**
 * The pinned notes from the index, kept fresh by the usual index invalidation
 * (a pin lands in the file, the watcher re-indexes it, the query refetches) and
 * made *immediately* consistent with an in-app pin by the optimistic pin
 * overlays: `toggleNotePinned` records what it just wrote, this hook merges it
 * over the indexed list, and the assertion retires once the index agrees.
 * Shared by the sidebar's Pinned section and the Recents dedup — one query
 * key, so both consumers ride a single fetch.
 */
export function usePinnedNotes(): PinnedNote[] {
  const { graph } = useGraph()
  const generation = graph?.generation
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: queryKeys.index.pinnedNotes(graph?.root),
    queryFn: () => getPinnedNotes(),
    enabled: bridgeReady && graph !== null,
  })
  const indexed = data ?? NONE
  const revision = useNoteRowOverlayRevision()
  const overlays = useMemo(() => pinOverlays(generation), [generation, revision])

  // Retire the assertions this list has caught up to. An effect, not a
  // render-time mutation: the store is shared, and writing it during render
  // would tear other subscribers.
  useEffect(() => {
    if (generation !== undefined && overlays.length > 0) {
      reconcilePinOverlays(generation, new Set(indexed.map((note) => note.path)))
    }
  }, [generation, overlays, indexed])

  return useMemo(() => withPinOverlays(indexed, overlays), [indexed, overlays])
}
