import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { applyNoteRowOverlays, type NoteListRowFacts, type NoteRowOverlay } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/*
 * The optimistic read overlay for note index rows lives in `@reflect/core`
 * (`NoteRowService`); this module is its React view.
 */

/**
 * Subscribe a component to `path`'s overlay on the open graph; `null` when none.
 */
export function useNoteRowOverlay(path: string): NoteRowOverlay | null {
  const { noteRows } = useCoreServices()
  const subscribe = useCallback((listener: () => void) => noteRows.subscribe(listener), [noteRows])
  const getSnapshot = useCallback(() => noteRows.getOverlay(path), [noteRows, path])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Subscribe a component to every overlay on the open graph, by path.
 */
export function useNoteRowOverlays(): ReadonlyMap<string, NoteRowOverlay> {
  const { noteRows } = useCoreServices()
  const subscribe = useCallback((listener: () => void) => noteRows.subscribe(listener), [noteRows])
  const getSnapshot = useCallback(() => noteRows.getOverlays(), [noteRows])
  return useSyncExternalStore(subscribe, getSnapshot)
}

export interface UseNoteRowsOptions {
  /**
   * The rows list every note a trashed note could be listed under, so a
   * trashed note missing from them is gone from the index.
   */
  complete?: boolean
}

/**
 * Listed index rows with the overlay merged over them: a trashed note leaves
 * the list and an overlay field the row type has takes the overlay's value.
 * The overlay retires as the rows catch up. `undefined` (still loading)
 * passes through.
 */
export function useNoteRows<Row extends NoteListRowFacts>(
  rows: readonly Row[] | undefined,
  options?: UseNoteRowsOptions,
): readonly Row[] | undefined {
  const { noteRows } = useCoreServices()
  const overlays = useNoteRowOverlays()
  const complete = options?.complete ?? false

  // An effect, not a render-time mutation: the store is shared, and writing it
  // during render would tear other subscribers.
  useEffect(() => {
    if (rows !== undefined && overlays.size > 0) {
      noteRows.reconcileRows(rows, { complete })
    }
  }, [noteRows, rows, overlays, complete])

  return useMemo(
    () => (rows === undefined ? undefined : applyNoteRowOverlays(rows, overlays)),
    [rows, overlays],
  )
}
