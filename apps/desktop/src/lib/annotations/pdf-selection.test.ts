import { describe, expect, it } from 'vitest'
import { normalizedSelectionRects, selectionToHighlight } from './pdf-selection'
import type { RectLike } from './pdf-selection'
import type { NormalizedRect, PdfTextItemLike, PdfViewportLike } from './pdf-region-text'

/** A scale-1 viewport mock for a 300x200 page, flipping y like real pdf.js. */
const VIEWPORT: PdfViewportLike = {
  width: 300,
  height: 200,
  convertToViewportRectangle: (r) => [r[0] ?? 0, 200 - (r[3] ?? 0), r[2] ?? 0, 200 - (r[1] ?? 0)],
}

function item(str: string, e: number, f: number, width: number, hasEOL?: boolean): PdfTextItemLike {
  return {
    str,
    transform: [1, 0, 0, 1, e, f],
    width,
    height: 12,
    ...(hasEOL !== undefined ? { hasEOL } : {}),
  }
}

function rect(left: number, top: number, right: number, bottom: number): NormalizedRect {
  return [left, top, right, bottom]
}

describe('selectionToHighlight', () => {
  it('hit-tests the selection rects and merges same-line items into one rect', () => {
    const result = selectionToHighlight(
      [rect(0.19, 0.18, 0.4, 0.26)],
      [item('Hello', 60, 150, 30), item('world', 90, 150, 28)],
      VIEWPORT,
      1,
    )
    expect(result).toEqual({
      pageIndex: 1,
      // [0.2, 0.19, 0.3, 0.25] ∪ [0.3, 0.19, 118/300, 0.25]
      rects: [[0.2, 0.19, 118 / 300, 0.25]],
      text: 'Hello world',
    })
  })

  it('produces one rect per visual line for a multiline selection', () => {
    const result = selectionToHighlight(
      [rect(0.19, 0.18, 0.4, 0.36)],
      [item('First', 60, 150, 24, true), item('line', 60, 130, 20)],
      VIEWPORT,
      2,
    )
    expect(result).toEqual({
      pageIndex: 2,
      rects: [
        [0.2, 0.19, 84 / 300, 0.25],
        [0.2, 0.29, 80 / 300, 0.35],
      ],
      text: 'First\nline',
    })
  })

  it('keeps the whole item when the selection rect only covers part of it', () => {
    // The browser rect may be narrower than the glyph run when a font is
    // substituted; the item is still hit, and its pdf.js bbox is used.
    const result = selectionToHighlight(
      [rect(0.21, 0.19, 0.24, 0.25)],
      [item('Hello', 60, 150, 30)],
      VIEWPORT,
      0,
    )
    expect(result?.rects).toEqual([[0.2, 0.19, 0.3, 0.25]])
  })

  it('returns null when no text item overlaps the selection', () => {
    expect(
      selectionToHighlight([rect(0.7, 0.7, 0.9, 0.9)], [item('Hello', 60, 150, 30)], VIEWPORT, 0),
    ).toBeNull()
  })

  it('cleans control characters, collapses whitespace runs, and keeps line breaks', () => {
    const result = selectionToHighlight(
      [rect(0.19, 0.18, 0.4, 0.26)],
      [item('\u{0}Hi \n  there\u{7F}', 60, 150, 60)],
      VIEWPORT,
      0,
    )
    expect(result?.text).toBe('Hi\nthere')
  })
})

describe('normalizedSelectionRects', () => {
  it('maps client rects to page-local fractions, dropping degenerate ones', () => {
    const pageRect: RectLike = { left: 100, top: 50, right: 400, bottom: 250 }
    const rects = normalizedSelectionRects(
      [
        { left: 120, top: 70, right: 220, bottom: 85 },
        // Zero height (a caret-ish line edge): dropped.
        { left: 120, top: 90, right: 180, bottom: 90 },
      ],
      pageRect,
    )
    expect(rects).toEqual([[20 / 300, 20 / 200, 120 / 300, 35 / 200]])
  })
})
