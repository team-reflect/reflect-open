import { describe, expect, it } from 'vitest'
import { selectionToHighlight } from './pdf-selection'
import type { PageElementLike, RectLike, SelectionLike } from './pdf-selection'

function selection(collapsed: boolean, rects: RectLike[], text: string): SelectionLike {
  return { collapsed, getClientRects: () => rects, toString: () => text }
}

function page(number: number | null, width = 300, height = 200): PageElementLike {
  return {
    getBoundingClientRect: () => ({ left: 100, top: 50, right: 100 + width, bottom: 50 + height }),
    getAttribute: (name) =>
      name === 'data-page-number' ? (number === null ? null : String(number)) : null,
  }
}

describe('selectionToHighlight', () => {
  it('maps each per-line client rect to a normalized rect', () => {
    const result = selectionToHighlight(
      selection(
        false,
        [
          { left: 120, top: 70, right: 220, bottom: 85 },
          { left: 120, top: 90, right: 180, bottom: 105 },
        ],
        'two lines',
      ),
      page(2),
    )
    expect(result).toEqual({
      pageIndex: 1,
      rects: [
        [20 / 300, 20 / 200, 120 / 300, 35 / 200],
        [20 / 300, 40 / 200, 80 / 300, 55 / 200],
      ],
      text: 'two lines',
    })
  })

  it('ignores a collapsed caret selection', () => {
    expect(selectionToHighlight(selection(true, [], ''), page(1))).toBeNull()
  })

  it('ignores a selection whose text is only whitespace', () => {
    expect(
      selectionToHighlight(
        selection(false, [{ left: 0, top: 0, right: 10, bottom: 10 }], ' \n '),
        page(1),
      ),
    ).toBeNull()
  })

  it('drops degenerate rects and clamps the rest into the page', () => {
    const result = selectionToHighlight(
      selection(
        false,
        [
          // Fully outside the page to the left: clamps to a zero-width sliver.
          { left: 20, top: 70, right: 40, bottom: 85 },
          // A normal rect, slightly past the right edge: clamps to the edge.
          { left: 120, top: 70, right: 410, bottom: 85 },
          // Zero height (a caret-ish line edge): dropped.
          { left: 120, top: 90, right: 180, bottom: 90 },
        ],
        'clamped',
      ),
      page(1),
    )
    expect(result).not.toBeNull()
    expect(result?.rects).toEqual([[20 / 300, 20 / 200, 1, 35 / 200]])
  })

  it('cleans control characters and collapses whitespace runs', () => {
    const result = selectionToHighlight(
      selection(false, [{ left: 120, top: 70, right: 220, bottom: 85 }], '\u{0}Hi \n  there\u{7F}'),
      page(1),
    )
    expect(result?.text).toBe('Hi there')
  })

  it('rejects a page element without a valid page number', () => {
    expect(
      selectionToHighlight(
        selection(false, [{ left: 120, top: 70, right: 220, bottom: 85 }], 'text'),
        page(null),
      ),
    ).toBeNull()
    expect(
      selectionToHighlight(
        selection(false, [{ left: 120, top: 70, right: 220, bottom: 85 }], 'text'),
        page(0),
      ),
    ).toBeNull()
  })
})
