import { clamp } from '@ocavue/utils'
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

export function isValidPinOrder(order: number | null | undefined): order is number {
  return order != null && Number.isSafeInteger(order) && order >= LO && order <= HI
}

export function getNextPinOrder(shelf: readonly PinnedNote[]): number {
  let highest: number | null = null
  for (const note of shelf) {
    const order = note.pinnedOrder
    if (isValidPinOrder(order) && (highest === null || order > highest)) {
      highest = order
    }
  }
  return highest === null ? GAP : Math.min(highest + GAP, HI)
}

/**
 * Number `shelf` so its orders ascend the way its notes now sit, renumbering
 * the whole shelf when the moved note has no number to take. Returns a new
 * array, leaving the original untouched.
 */
export function updatePinOrder(
  shelf: readonly PinnedNote[],
  movedPath: string,
): PinnedNote[] | null {
  if (isSorted(shelf)) {
    return [...shelf]
  }
  const moved = shelf.findIndex((note) => note.path === movedPath)
  if (moved === -1) {
    return renumberPinOrder(shelf)
  }
  const order = getOrderBetween(
    getSafePinnedOrder(shelf[moved - 1]),
    getSafePinnedOrder(shelf[moved + 1]),
  )
  const next = shelf.map((note, index) =>
    index === moved && order !== null ? { ...note, pinnedOrder: order } : note,
  )
  return isSorted(next) ? next : renumberPinOrder(next)
}

export function renumberPinOrder(shelf: readonly PinnedNote[]): PinnedNote[] {
  const minStep = 1
  const maxStep = GAP
  const step = clamp(Math.floor(HI / (shelf.length + 1)), minStep, maxStep)
  return shelf.map((note, index) => ({ ...note, pinnedOrder: step * (index + 1) }))
}

function isSorted(shelf: readonly PinnedNote[]): boolean {
  let previous: number | null = null
  for (const note of shelf) {
    const order = note.pinnedOrder
    if (!isValidPinOrder(order) || (previous !== null && order <= previous)) {
      return false
    }
    previous = order
  }
  return true
}

/**
 * An order strictly between two neighbours, or `null` when no whole number
 * fits. Past the last note the next order opens a fresh gap rather than
 * jumping halfway to {@link HI}, which would write a ten-digit number for
 * dragging a two-note shelf.
 */
function getOrderBetween(before?: number | null, after?: number | null): number | null {
  if (before == null) {
    if (after == null) {
      return GAP
    }
    const result = Math.floor(after / 2)
    return result < after && isValidPinOrder(result) ? result : null
  }
  if (after == null) {
    const result = before + GAP
    return isValidPinOrder(result) ? result : null
  }
  const result = Math.floor((before + after) / 2)
  return before < result && result < after && isValidPinOrder(result) ? result : null
}

function getSafePinnedOrder(note: PinnedNote | undefined): number | undefined {
  const order = note?.pinnedOrder
  return isValidPinOrder(order) ? order : undefined
}
