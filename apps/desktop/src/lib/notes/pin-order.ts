import type { PinnedNote } from '@reflect/core'

/**
 * Spacing between orders when the shelf is numbered from scratch, and the step
 * an appended pin takes past the last one. A drop between two neighbours halves
 * the gap it lands in, so one slot takes `log2(GAP)` drops before it runs out of
 * whole numbers and the shelf is renumbered. A wider gap renumbers less often
 * but puts longer numbers in markdown a reader edits by hand.
 */
const GAP = 1024

/**
 * The order range. It starts at zero because `pinned: 0` is a real order, not
 * an absent one, and frontmatter is hand-editable, so values outside it exist.
 */
const LO = 0
const HI = 2 ** 31 - 1

/** One note's new `pinned: <n>`. */
export interface PinOrderWrite {
  path: string
  order: number
}

/** A whole number inside the range: anything else can't be averaged against. */
export function usablePinOrder(order: number | null | undefined): order is number {
  return (
    order !== null &&
    order !== undefined &&
    Number.isSafeInteger(order) &&
    order >= LO &&
    order <= HI
  )
}

/**
 * The writes that put `movedPath` where `shelf` now has it: one note's order
 * when a whole number fits between its new neighbours, else a renumbered shelf.
 * `shelf` is the order the drop produced, with every other note's order intact.
 */
export function planPinReorder(shelf: readonly PinnedNote[], movedPath: string): PinOrderWrite[] {
  const moved = shelf.findIndex((note) => note.path === movedPath)
  if (moved === -1) {
    return []
  }
  // `null` is the end of the shelf; `undefined` a neighbour carrying no order
  // to sit between, such as a bare `pinned: true`.
  const before = moved === 0 ? null : neighbourOrder(shelf[moved - 1])
  const after = moved === shelf.length - 1 ? null : neighbourOrder(shelf[moved + 1])
  const order = before === undefined || after === undefined ? null : orderBetween(before, after)
  return order === null ? renumberPinShelf(shelf) : [{ path: movedPath, order }]
}

/** Space every note a gap apart, dropping the notes already sitting right. */
export function renumberPinShelf(shelf: readonly PinnedNote[]): PinOrderWrite[] {
  const step = Math.max(1, Math.min(GAP, Math.floor(HI / (shelf.length + 1))))
  return shelf
    .map((note, index) => ({ path: note.path, order: step * (index + 1) }))
    .filter((write, index) => write.order !== shelf[index]?.pinnedOrder)
}

/**
 * An order strictly between two neighbours, or `null` when no whole number
 * fits. An absent neighbour is the end of the shelf: past the last note the
 * next order opens a fresh gap rather than jumping halfway to {@link HI},
 * which would write a ten-digit number for dragging a two-note shelf.
 */
function orderBetween(before: number | null, after: number | null): number | null {
  if (before === null) {
    if (after === null) {
      return GAP
    }
    return after > LO ? Math.floor(after / 2) : null
  }
  if (after === null) {
    return before + GAP <= HI ? before + GAP : null
  }
  return after - before >= 2 ? Math.floor((before + after) / 2) : null
}

/** The order of a note a drop landed next to, or `undefined` if it has none. */
function neighbourOrder(note: PinnedNote | undefined): number | undefined {
  const order = note?.pinnedOrder
  return usablePinOrder(order) ? order : undefined
}
