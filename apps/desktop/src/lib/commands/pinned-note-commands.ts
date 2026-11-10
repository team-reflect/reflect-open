import { applyPinnedNoteOverlays, errorMessage, type PinnedNote } from '@reflect/core'
import { routeForPath } from '@reflect/app'
import type { AppCommand, CommandContext } from './types.ts'

// The number row is shared: ⌘1–⌘5 switch graphs and ⌘6–⌘9 open the top
// pinned notes. Few people keep more than five graphs, so the high digits
// buy more as one-keystroke access to the Pinned shelf.
export const GRAPH_SWITCH_COUNT = 5
const PINNED_NOTE_SHORTCUT_COUNT = 4

// Only the path of a not-yet-indexed overlay entry matters for opening it.
function previewEntry(path: string): PinnedNote {
  return { path, title: path, dailyDate: null, pinnedOrder: null }
}

/**
 * Open the note at zero-based `index` on the Pinned shelf, in the order the
 * sidebar shows it (the index's shelf with the optimistic note-row overlay
 * merged over it). Does nothing without an open graph, past the end of the
 * shelf, or when the graph changes while the shelf is read. Never rejects: a
 * failed index read surfaces on the operations status line.
 */
export async function openPinnedNote(
  context: Pick<CommandContext, 'services' | 'app' | 'navigate'>,
  index: number,
): Promise<void> {
  const { graphSession, indexQuery, noteRows } = context.services
  const { session } = graphSession.get()
  if (session === null) {
    return
  }
  let indexed: PinnedNote[]
  try {
    indexed = await indexQuery.getPinnedNotes()
  } catch (cause) {
    context.app.operations.start('Opening pinned note').fail(errorMessage(cause))
    return
  }
  if (graphSession.get().session !== session) {
    return
  }
  const note = applyPinnedNoteOverlays(indexed, noteRows.get(), previewEntry)[index]
  if (note !== undefined) {
    context.navigate(routeForPath(note.path))
  }
}

/** ⌘6–⌘9: open the top four pinned notes, in shelf order. */
export const PINNED_NOTE_COMMANDS: AppCommand[] = Array.from(
  { length: PINNED_NOTE_SHORTCUT_COUNT },
  (_, index) => {
    const position = index + 1
    return {
      id: `pinned.open${position}`,
      title: `Open pinned note ${position}`,
      keywords: ['pinned', 'pin', 'shelf', 'favorite'],
      keybinding: `Mod-${GRAPH_SWITCH_COUNT + position}`,
      run: (context) => openPinnedNote(context, index),
    }
  },
)
