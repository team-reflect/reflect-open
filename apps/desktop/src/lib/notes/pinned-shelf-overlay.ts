import { dateFromDailyPath, type PinnedNote } from '@reflect/core'
import type { PinOverlay } from '@/hooks/note-row-overlay'

/**
 * The shelf title for a note the index has not listed yet. The real title is
 * one index round trip away, and a graph's filenames follow its titles, so the
 * stand-in is almost always the title itself.
 */
function titleFromPath(path: string): string {
  const name = path.split('/').at(-1) ?? path
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

/**
 * `getPinnedNotes`'s ordering for the bare `pinned: true` group, in JS: by
 * case-folded title, path as the tiebreak. Kept in step with that SQL by hand;
 * it only ever sorts the handful of notes an assertion adds.
 */
function comparePinnedNote(left: PinnedNote, right: PinnedNote): number {
  const titleOrder = left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
  return titleOrder === 0 ? left.path.localeCompare(right.path) : titleOrder
}

/** Whether the note carries an explicit `pinned: <n>`, which drag reorder writes. */
function hasPinnedOrder(note: PinnedNote): boolean {
  return note.pinnedOrder !== null && note.pinnedOrder !== undefined
}

/**
 * The pinned shelf as it will read once the index catches up: the indexed list
 * with each asserted pin applied. A note asserted pinned that the index has not
 * listed yet joins the unordered group — toggling a pin on writes a bare
 * `pinned: true`, and only drag reorder writes an order — which is then sorted
 * the way `getPinnedNotes` sorts it, so a note does not jump position when the
 * assertion retires.
 */
export function withPinOverlays(
  pinned: PinnedNote[],
  overlays: readonly PinOverlay[],
): PinnedNote[] {
  if (overlays.length === 0) {
    return pinned
  }
  const listed = new Set(pinned.map((note) => note.path))
  const removed = new Set(
    overlays.filter((overlay) => !overlay.isPinned).map((overlay) => overlay.path),
  )
  const added = overlays
    .filter((overlay) => overlay.isPinned && !listed.has(overlay.path))
    .map((overlay): PinnedNote => ({
      path: overlay.path,
      title: titleFromPath(overlay.path),
      dailyDate: dateFromDailyPath(overlay.path),
      pinnedOrder: null,
    }))
  const kept = pinned.filter((note) => !removed.has(note.path))
  if (added.length === 0) {
    return kept
  }
  const ordered = kept.filter(hasPinnedOrder)
  const bare = [...kept.filter((note) => !hasPinnedOrder(note)), ...added]
  bare.sort(comparePinnedNote)
  return [...ordered, ...bare]
}
