import type { PinnedNoteRow } from '@reflect/types'
import { applyPinnedNoteOverlays, errorMessage, type CoreServices } from '@reflect/core'
import { routeForPath, type AppServices, type Route } from '@reflect/app'

/**
 * What {@link openPinnedNote} reads the shelf from and navigates with.
 */
export interface OpenPinnedNoteContext {
  services: Pick<CoreServices, 'graphSession' | 'indexQuery' | 'noteRows'>
  app: Pick<AppServices, 'operations'>
  navigate: (route: Route) => void
}

// Only the path of a not-yet-indexed overlay entry matters for opening it.
function previewEntry(path: string): PinnedNoteRow {
  return { path, title: path, dailyDate: null, pinnedOrder: null }
}

/**
 * Open the note at zero-based `index` on the Pinned shelf, in the order the
 * sidebar shows it (the index's shelf with the optimistic note-row overlay
 * merged over it). Does nothing without an open graph, past the end of the
 * shelf, or when the graph changes while the shelf is read. Never rejects: a
 * failed index read surfaces on the operations status line.
 */
export async function openPinnedNote(context: OpenPinnedNoteContext, index: number): Promise<void> {
  const { graphSession, indexQuery, noteRows } = context.services
  const { session } = graphSession.get()
  if (session === null) {
    return
  }
  let indexed: PinnedNoteRow[]
  try {
    indexed = await indexQuery.getPinnedNotes()
  } catch (cause) {
    context.app.operations.start('Opening pinned note').fail(errorMessage(cause))
    return
  }
  if (graphSession.get().session !== session) {
    return
  }
  const note = applyPinnedNoteOverlays(
    indexed,
    noteRows.getOverlaysOn(session.generation),
    previewEntry,
  )[index]
  if (note !== undefined) {
    context.navigate(routeForPath(note.path))
  }
}
