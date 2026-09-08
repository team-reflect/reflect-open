import { describe, expect, it } from 'vitest'
import type { PinnedNote } from '@reflect/core'
import { nextPinOrder, planPinReorder, renumberPinShelf, usablePinOrder } from './pin-order'

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

describe('usablePinOrder', () => {
  it('accepts whole numbers in range and rejects everything else', () => {
    // `pinned: 0` is a real order, and the shelf writer used to start there.
    expect([0, 1024, HI].every(usablePinOrder)).toBe(true)
    expect([null, undefined, -1, HI + 1, 1.5, NaN].some(usablePinOrder)).toBe(false)
  })
})

describe('nextPinOrder', () => {
  it('opens the shelf at one gap', () => {
    expect(nextPinOrder([])).toBe(1024)
    expect(nextPinOrder(shelf(null))).toBe(1024)
  })

  it('steps past a shelf the old writer numbered from zero', () => {
    expect(nextPinOrder(shelf(0, 1))).toBe(1025)
  })

  it('steps a gap past the highest order, wherever it sits', () => {
    expect(nextPinOrder(shelf(1024, 5000, 2048))).toBe(6024)
  })

  it('ignores orders it cannot reason about', () => {
    expect(nextPinOrder(shelf(1024, null))).toBe(2048)
  })

  it('clamps at the top of the range', () => {
    expect(nextPinOrder(shelf(HI))).toBe(HI)
  })
})

describe('planPinReorder', () => {
  it('writes only the moved note when a whole number fits between its neighbours', () => {
    expect(planPinReorder(shelf(1024, 3072, 2048), '1.md')).toEqual([{ path: '1.md', order: 1536 }])
  })

  it('halves downwards for a note dropped first', () => {
    expect(planPinReorder(shelf(2048, 1024), '0.md')).toEqual([{ path: '0.md', order: 512 }])
  })

  it('opens a fresh gap for a note dropped last rather than jumping to the top', () => {
    expect(planPinReorder(shelf(2048, 1024), '1.md')).toEqual([{ path: '1.md', order: 3072 }])
  })

  it('renumbers when the neighbours are already adjacent', () => {
    expect(planPinReorder(shelf(1024, 9999, 1025), '1.md')).toEqual([
      { path: '1.md', order: 2048 },
      { path: '2.md', order: 3072 },
    ])
  })

  it('renumbers when a neighbour is a bare pin', () => {
    expect(planPinReorder(shelf(1024, null, 3072), '0.md')).toEqual([{ path: '1.md', order: 2048 }])
  })

  it('renumbers rather than pushing past the top of the range', () => {
    expect(planPinReorder(shelf(HI, 1024), '1.md')).toEqual([
      { path: '0.md', order: 1024 },
      { path: '1.md', order: 2048 },
    ])
  })

  it('leaves an unknown path alone', () => {
    expect(planPinReorder(shelf(1024), 'missing.md')).toEqual([])
  })
})

describe('renumberPinShelf', () => {
  it('spaces the shelf a gap apart and skips the notes already sitting right', () => {
    expect(renumberPinShelf(shelf(1024, 5000, 3072))).toEqual([{ path: '1.md', order: 2048 }])
  })

  it('stays in range and strictly ascending across a long shelf', () => {
    const written = renumberPinShelf(shelf(...Array.from({ length: 200 }, () => null)))
    expect(written).toHaveLength(200)
    expect(written.every((write) => usablePinOrder(write.order))).toBe(true)
    expect(
      written.every((write, index) => index === 0 || write.order > written[index - 1]!.order),
    ).toBe(true)
  })
})
