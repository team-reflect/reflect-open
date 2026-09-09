import type { PinnedNote } from '@reflect/core'

/**
 * Spacing between orders when the shelf is numbered from scratch.
 */
const GAP = 1024

/**
 * The order range.
 */
const LO = 0
const HI = 2 ** 31 - 1

/**
 * One note's new `pinned: <n>`
 * FIXME: let's remove the "PinOrderWrite" concept. "planPinReorder" function should just accept a shelf and return a new shelf with updated pinnedOrder values.
 */
export interface PinOrderWrite {
  path: string

  // FIXME: rename "order" to "pinnedOrder"
  order: number
}

export function usablePinOrder(order: number | null | undefined): order is number {
  // FIXME: rename "usablePinOrder" to "isValidPinOrder".
  return (
    typeof order === 'number' &&
    Number.isSafeInteger(order) &&
    order >= LO &&
    order <= HI
  )
}

export function nextPinOrder(shelf: readonly PinnedNote[]): number {
  // FIXME: rename "nextPinOrder" to "getNextPinOrder"
  let highest: number | null = null
  for (const note of shelf) {
    const order = note.pinnedOrder
    if (usablePinOrder(order) && (highest === null || order > highest)) {
      highest = order
    }
  }
  return highest === null ? GAP : Math.min(highest + GAP, HI)
}

/**
 * FIXME: make the JSDoc here super super simple.
 * FIXME: update the function signature to accept a shelf and return a new shelf with updated pinnedOrder values. function planPinReorder(shelf: readonly PinnedNote[], movedPath: string): PinnedNote[] {
 * The writes that put `movedPath` where `shelf` now has it: one note's order
 * when a whole number fits between its new neighbours, else a renumbered shelf.
 * `shelf` is the order the drop produced, with every other note's order intact.
 */
export function planPinReorder(shelf: readonly PinnedNote[], movedPath: string): PinOrderWrite[] {

  // FIXME: 1. if len(shelf) <= 1, just return shelf
  // FIXME: 2. before the final return, check if the whole shelf is already in order, if not, return renumberPinShelf(shelf)


  const moved = shelf.findIndex((note) => note.path === movedPath)
  if (moved === -1) {
    return []
  }
  // FIXME: remove the comment below
  // `null` is the end of the shelf; `undefined` a neighbour carrying no order
  // to sit between, such as a bare `pinned: true`.
  const before = moved === 0 ? null : neighbourOrder(shelf[moved - 1])
  const after = moved === shelf.length - 1 ? null : neighbourOrder(shelf[moved + 1])
  const order = before === undefined || after === undefined ? null : orderBetween(before, after)
  return order === null ? renumberPinShelf(shelf) : [{ path: movedPath, order }]
}

/** Space every note a gap apart, dropping the notes already sitting right. */
export function renumberPinShelf(shelf: readonly PinnedNote[]): PinOrderWrite[] {
  // FIXME: use the `clamp` function from `@ocavue/utils`. Also create minStep and maxStep variables in this function before using the `clamp` function to that it's more readable.
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
function orderBetween(before?: number|null, after?:number|null): number | null {
  // FIXME: rename "orderBetween" to "getOrderBetween"
  if (before == null) {
    if (after == null) {
      return GAP
    }
    const result = Math.floor(after / 2)
    return result < after && usablePinOrder(result) ? result  : null
  }
  if (after == null) {
    const result = before + GAP
    return usablePinOrder(result) ? result  : null
  }
  const result = Math.floor((before + after) / 2)
  return before < result  && result < after && usablePinOrder(result) ? result : null
}

/** The order of a note a drop landed next to, or `undefined` if it has none. */
function neighbourOrder(note: PinnedNote | undefined): number | undefined {
  // FIXME: rename "neighbourOrder" to "getSafePinnedOrder"
  const order = note?.pinnedOrder
  return usablePinOrder(order) ? order : undefined
}
