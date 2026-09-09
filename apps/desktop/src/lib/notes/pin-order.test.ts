import { describe, expect, it } from 'vitest'
import type { PinnedNote } from '@reflect/core'
import { getNextPinOrder, isValidPinOrder, planPinReorder, renumberPinShelf } from './pin-order'

const HI = 2 ** 31 - 1

/** A shelf in the order a drop left it, each note carrying the order it still has. */
function shelf(...orders: (number | null)[]): PinnedNote[] {
  return orders.map((pinnedOrder, index) => ({
    path: `${index}.md`,
    title: String(index),
    dailyDate: null,
    pinnedOrder,
  }))
}

describe('isValidPinOrder', () => {
  it('accepts whole numbers in range and rejects everything else', () => {
    // `pinned: 0` is a real order, and the shelf writer used to start there.
    expect([0, 1024, HI].every(isValidPinOrder)).toBe(true)
    expect([null, undefined, -1, HI + 1, 1.5, NaN].some(isValidPinOrder)).toBe(false)
  })
})

describe('getNextPinOrder', () => {
  it('opens the shelf at one gap', () => {
    expect(getNextPinOrder([])).toBe(1024)
    expect(getNextPinOrder(shelf(null))).toBe(1024)
  })

  it('steps past a shelf the old writer numbered from zero', () => {
    expect(getNextPinOrder(shelf(0, 1))).toBe(1025)
  })

  it('steps a gap past the highest order, wherever it sits', () => {
    expect(getNextPinOrder(shelf(1024, 5000, 2048))).toBe(6024)
  })

  it('ignores orders it cannot reason about', () => {
    expect(getNextPinOrder(shelf(1024, null))).toBe(2048)
  })

  it('clamps at the top of the range', () => {
    expect(getNextPinOrder(shelf(HI))).toBe(HI)
  })
})

describe('planPinReorder', () => {
  it('renumbers only the moved note when a whole number fits between its neighbours', () => {
    expect(planPinReorder(shelf(1024, 3072, 2048), '1.md')).toEqual(shelf(1024, 1536, 2048))
  })

  it('halves downwards for a note dropped first', () => {
    expect(planPinReorder(shelf(2048, 1024), '0.md')).toEqual(shelf(512, 1024))
  })

  it('opens a fresh gap for a note dropped last rather than jumping to the top', () => {
    expect(planPinReorder(shelf(2048, 1024), '1.md')).toEqual(shelf(2048, 3072))
  })

  it('renumbers the shelf when the neighbours are already adjacent', () => {
    expect(planPinReorder(shelf(1024, 9999, 1025), '1.md')).toEqual(shelf(1024, 2048, 3072))
  })

  it('renumbers the shelf when a neighbour is a bare pin', () => {
    expect(planPinReorder(shelf(1024, null, 3072), '0.md')).toEqual(shelf(1024, 2048, 3072))
  })

  it('renumbers rather than pushing past the top of the range', () => {
    expect(planPinReorder(shelf(HI, 1024), '1.md')).toEqual(shelf(1024, 2048))
  })

  it('leaves an unknown path alone', () => {
    expect(planPinReorder(shelf(1024, 2048), 'missing.md')).toEqual(shelf(1024, 2048))
  })

  it('leaves a shelf that cannot be reordered alone', () => {
    expect(planPinReorder(shelf(9999), '0.md')).toEqual(shelf(9999))
  })
})

describe('renumberPinShelf', () => {
  it('spaces the shelf a gap apart', () => {
    expect(renumberPinShelf(shelf(1024, 5000, 3072))).toEqual(shelf(1024, 2048, 3072))
  })

  it('stays in range and strictly ascending across a long shelf', () => {
    const orders = renumberPinShelf(shelf(...Array.from({ length: 200 }, () => null)))
      .map((note) => note.pinnedOrder)
      .filter(isValidPinOrder)
    expect(orders).toHaveLength(200)
    expect(orders.every((order, index) => index === 0 || order > orders[index - 1]!)).toBe(true)
  })
})
