import { describe, expect, it } from 'vitest'
import { normalizedSelectionRects, selectionPages, selectionToHighlight } from './pdf-selection'
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

/** A selection's text for a single line: its own string, cleaned inside. */
function highlight(
  selectionRects: readonly NormalizedRect[],
  textItems: readonly PdfTextItemLike[],
  pageIndex: number,
  selectionText: string,
) {
  return selectionToHighlight(selectionRects, textItems, VIEWPORT, pageIndex, selectionText)
}

describe('selectionToHighlight', () => {
  it('clips a hit item to the selection extent so a partial-line selection stays partial', () => {
    // One whole-line item, selected only up to x=0.45: the highlight must
    // cover just the covered run, not the whole line.
    const result = highlight(
      [rect(0.2, 0.18, 0.45, 0.26)],
      [item('Hello world', 60, 150, 210)],
      0,
      'Hello',
    )
    expect(result).toEqual({
      pageIndex: 0,
      rects: [[0.2, 0.19, 0.45, 0.25]],
      text: 'Hello',
    })
  })

  it('merges clipped same-line items into one rect spanning their union', () => {
    const result = highlight(
      [rect(0.19, 0.18, 0.4, 0.26)],
      [item('Hello', 60, 150, 30), item('world', 90, 150, 28)],
      1,
      'Hello world',
    )
    expect(result).toEqual({
      pageIndex: 1,
      rects: [[0.2, 0.19, 118 / 300, 0.25]],
      text: 'Hello world',
    })
  })

  it('clips each line separately for a multiline selection', () => {
    const result = highlight(
      [rect(0.19, 0.18, 0.4, 0.26), rect(0.19, 0.28, 0.5, 0.36)],
      [item('First', 60, 150, 24, true), item('line', 60, 130, 20)],
      2,
      'First\nline',
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

  it('clips the item when the browser rect only covers part of the run', () => {
    // The browser rect may be narrower than the glyph run when a font is
    // substituted; the item is still hit, and the rect clips to the selection.
    const result = highlight(
      [rect(0.21, 0.19, 0.24, 0.25)],
      [item('Hello', 60, 150, 30)],
      0,
      'Hell',
    )
    expect(result?.rects).toEqual([[0.21, 0.19, 0.24, 0.25]])
  })

  it('skips non-text regions (images) — only hit text items contribute', () => {
    // The selection covers a wide run, but only one text item lies in it; the
    // "image" area contributes no rect and no text.
    const result = highlight(
      [rect(0.05, 0.05, 0.9, 0.95)],
      [item('Hello', 60, 150, 30)],
      0,
      'Hello',
    )
    expect(result?.rects).toEqual([[0.2, 0.19, 0.3, 0.25]])
    expect(result?.text).toBe('Hello')
  })

  it('returns null when no text item overlaps the selection', () => {
    expect(
      highlight([rect(0.7, 0.7, 0.9, 0.9)], [item('Hello', 60, 150, 30)], 0, 'Hello'),
    ).toBeNull()
  })

  it('cleans control characters, collapses whitespace runs, and keeps line breaks', () => {
    const result = highlight(
      [rect(0.19, 0.18, 0.4, 0.26)],
      [item('\u{0}Hi \n  there\u{7F}', 60, 150, 60)],
      0,
      '\u{0}Hi \n  there\u{7F}',
    )
    expect(result?.text).toBe('Hi\nthere')
  })
})

describe('selectionPages', () => {
  const pageRect: RectLike = { left: 0, top: 0, right: 300, bottom: 400 }
  const page1 = { getAttribute: () => '1', getBoundingClientRect: () => pageRect }
  const page2 = { getAttribute: () => '2', getBoundingClientRect: () => pageRect }
  const page3 = { getAttribute: () => '3', getBoundingClientRect: () => pageRect }
  const allPages = [page1, page2, page3]

  it('yields the single page for a same-page selection', () => {
    expect(selectionPages(page2, page2, allPages)).toEqual([page2])
  })

  it('yields every page between start and end, inclusive, in document order', () => {
    expect(selectionPages(page1, page3, allPages)).toEqual([page1, page2, page3])
    // Reverse drag direction still resolves the same ordered span.
    expect(selectionPages(page3, page1, allPages)).toEqual([page1, page2, page3])
  })

  it('yields nothing when either edge is outside a page', () => {
    expect(selectionPages(null, page2, allPages)).toEqual([])
    expect(selectionPages(page2, null, allPages)).toEqual([])
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
