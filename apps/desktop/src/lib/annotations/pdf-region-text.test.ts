import { describe, expect, it } from 'vitest'
import { extractRegionText } from './pdf-region-text'
import type { AnnotationItem } from './annotations-store'

function item(partial: Partial<AnnotationItem>): AnnotationItem {
  return {
    id: 'a1',
    pageIndex: 0,
    type: 'border',
    rects: [[0.1, 0.1, 0.5, 0.3]],
    color: '#FFD400',
    text: '',
    ...partial,
  }
}

/**
 * A scale-1 viewport mock for a 300x200 page: convertToViewportRectangle flips
 * the y axis (PDF user space grows up → display grows down), like real pdf.js.
 */
function pageMock(textItems: unknown[]) {
  return {
    getTextContent: async () => ({ items: textItems }),
    getViewport: () => ({
      width: 300,
      height: 200,
      convertToViewportRectangle: (r: number[]) => [
        r[0] ?? 0,
        200 - (r[3] ?? 0),
        r[2] ?? 0,
        200 - (r[1] ?? 0),
      ],
    }),
  }
}

const docMock = (page: unknown) => ({ getPage: async () => page })

describe('extractRegionText', () => {
  it('joins the text items whose bboxes overlap the annotation rect', async () => {
    // Baseline (60, 150), running to x=90 with height 12: PDF space
    // [60,150,90,162] → display [60, 38, 90, 50] → normalized
    // [0.2, 0.19, 0.3, 0.25], inside the annotation rect.
    const doc = docMock(
      pageMock([
        { str: 'Hello', transform: [1, 0, 0, 1, 60, 150], width: 30, height: 12, hasEOL: false },
        { str: 'world', transform: [1, 0, 0, 1, 90, 150], width: 28, height: 12, hasEOL: false },
        { str: 'far', transform: [1, 0, 0, 1, 220, 150], width: 18, height: 12, hasEOL: false },
      ]),
    )
    await expect(extractRegionText(doc as never, item({}))).resolves.toBe('Hello world')
  })

  it('honors line breaks through hasEOL', async () => {
    const doc = docMock(
      pageMock([
        { str: 'First', transform: [1, 0, 0, 1, 60, 150], width: 24, height: 12, hasEOL: true },
        { str: 'line', transform: [1, 0, 0, 1, 60, 130], width: 20, height: 12, hasEOL: false },
      ]),
    )
    await expect(extractRegionText(doc as never, item({}))).resolves.toBe('First\nline')
  })

  it('returns null when no text overlaps the rect', async () => {
    const doc = docMock(
      pageMock([
        { str: 'far', transform: [1, 0, 0, 1, 220, 150], width: 18, height: 12, hasEOL: false },
      ]),
    )
    await expect(extractRegionText(doc as never, item({}))).resolves.toBeNull()
  })

  it('normalizes viewport corners that real pdf.js returns unsorted', async () => {
    // Real `PageViewport.convertToViewportRectangle` applies the y-flip to the
    // two corners and returns the raw transformed points — `[left, bottom,
    // right, top]` order (the top-left corner in PDF space is the bottom in
    // display space). Regression: the rect math must not assume sorted output.
    const unsortedPage = {
      getTextContent: async () => ({
        items: [
          { str: 'Hello', transform: [1, 0, 0, 1, 60, 150], width: 30, height: 12, hasEOL: false },
        ],
      }),
      getViewport: () => ({
        width: 300,
        height: 200,
        convertToViewportRectangle: (r: number[]) => [
          r[0] ?? 0,
          200 - (r[1] ?? 0),
          r[2] ?? 0,
          200 - (r[3] ?? 0),
        ],
      }),
    }
    await expect(extractRegionText(docMock(unsortedPage) as never, item({}))).resolves.toBe('Hello')
  })

  it('returns null for a missing rect or a failing page read', async () => {
    await expect(extractRegionText(docMock({}) as never, item({ rects: [] }))).resolves.toBeNull()
    await expect(
      extractRegionText(
        {
          getPage: async () => {
            throw new Error('gone')
          },
        } as never,
        item({}),
      ),
    ).resolves.toBeNull()
  })
})
