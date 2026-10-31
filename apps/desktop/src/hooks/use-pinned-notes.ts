import { useCallback, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  applyPinnedNoteOverlays,
  dateFromDailyPath,
  type NoteRow,
  type PinnedNote,
} from '@reflect/core'
import { useNoteRowOverlays } from '@/hooks/note-row-overlay.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

const EMPTY: readonly PinnedNote[] = []

function titleFromPath(path: string): string {
  const name = path.split('/').at(-1) ?? path
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

/**
 * The pinned notes from the index, kept fresh by the usual index invalidation
 * (a pin lands in the file, the watcher re-indexes it, the query refetches),
 * with the note-row overlay merged over them so a pin, unpin, or reorder
 * shows at once. Shared by the sidebar's Pinned section and the Recents dedup:
 * one query key, so both consumers ride a single fetch.
 */
export function usePinnedNotes(): readonly PinnedNote[] {
  const { graph } = useGraph()
  const root = graph?.root
  const { indexQuery, noteRows } = useCoreServices()
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: queryKeys.index.pinnedNotes(root),
    queryFn: () => indexQuery.getPinnedNotes(),
    enabled: graph !== null,
  })
  const overlays = useNoteRowOverlays()

  useEffect(() => {
    if (data !== undefined && overlays.size > 0) {
      noteRows.reconcileRows(
        data.map((note) => ({
          path: note.path,
          isPinned: true,
          pinnedOrder: note.pinnedOrder ?? null,
        })),
      )
    }
  }, [noteRows, data, overlays])

  // A note the index does not list yet: its cached row's title, else its file name.
  const preview = useCallback(
    (path: string): PinnedNote => {
      const row = queryClient.getQueryData<NoteRow | null>(queryKeys.index.note(root, path))
      return {
        path,
        title: row?.title ?? titleFromPath(path),
        dailyDate: row?.dailyDate ?? dateFromDailyPath(path),
        pinnedOrder: null,
      }
    },
    [queryClient, root],
  )

  return useMemo(
    () => applyPinnedNoteOverlays(data ?? EMPTY, overlays, preview),
    [data, overlays, preview],
  )
}
