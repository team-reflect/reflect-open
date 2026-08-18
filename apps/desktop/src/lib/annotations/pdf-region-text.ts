import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { AnnotationItem } from './annotations-store'

/** A normalized annotation rectangle, `[left, top, right, bottom]` in 0–1. */
export type NormalizedRect = [number, number, number, number]

/** A pdf.js text item, narrowed to the bits the coordinate math needs. */
export interface PdfTextItemLike {
  str: string
  transform: readonly number[]
  width: number
  height: number
  hasEOL?: boolean
}

/** A page viewport at any scale: sizes for normalization, the rect mapper. */
export interface PdfViewportLike {
  width: number
  height: number
  convertToViewportRectangle(rect: readonly number[]): readonly number[]
}

/**
 * A text item's bbox in the normalized 0–1 display space (top-left origin,
 * y growing down — the same space as the annotation rects), from its
 * transform and the page viewport.
 *
 * Coordinate math: a text item's transform is `[a, b, c, d, e, f]`; the
 * baseline starts at `(e, f)` in PDF user space and runs `width` along x with
 * `height` of font height (PDF y grows up), so its bbox is
 * `[e, f, e + width, f + height]`. `convertToViewportRectangle` maps that to
 * display pixels; dividing by the viewport size yields the 0–1 fractions,
 * independent of the render scale.
 *
 * The viewport transform flips y (PDF user space origin is bottom-left), so
 * `convertToViewportRectangle` returns the *raw* transformed corners —
 * `[left, bottom, right, top]` order, not sorted. The min/max normalization
 * below rebuilds a proper top-left-origin rect regardless of the corner
 * ordering, which is what keeps the hit-testing and region-text extraction
 * aligned with the rendered glyphs.
 */
export function textItemNormalizedRect(
  item: PdfTextItemLike,
  viewport: PdfViewportLike,
): NormalizedRect {
  const [, , , , e, f] = item.transform
  const [rx1, ry1, rx2, ry2] = viewport.convertToViewportRectangle([
    e ?? 0,
    f ?? 0,
    (e ?? 0) + item.width,
    (f ?? 0) + item.height,
  ])
  const left = Math.min(rx1 ?? 0, rx2 ?? 0)
  const right = Math.max(rx1 ?? 0, rx2 ?? 0)
  const top = Math.min(ry1 ?? 0, ry2 ?? 0)
  const bottom = Math.max(ry1 ?? 0, ry2 ?? 0)
  return [
    left / viewport.width,
    top / viewport.height,
    right / viewport.width,
    bottom / viewport.height,
  ]
}

/**
 * Whether two normalized rectangles (0–1, display coordinates) have positive
 * overlap.
 */
export function rectsOverlap(a: readonly number[], b: readonly number[]): boolean {
  const overlapX = Math.min(a[2] ?? 0, b[2] ?? 0) - Math.max(a[0] ?? 0, b[0] ?? 0)
  const overlapY = Math.min(a[3] ?? 0, b[3] ?? 0) - Math.max(a[1] ?? 0, b[1] ?? 0)
  return overlapX > 0 && overlapY > 0
}

/**
 * Extract the PDF text covered by a border annotation's rect: read the page's
 * text layer, convert each text item's bbox to the same normalized display
 * coordinates as the annotation, and intersect with the rect; matching items
 * join in reading order.
 *
 * Returns null when nothing overlaps or the read fails (the caller decides
 * the status-line feedback).
 */
export async function extractRegionText(
  doc: PDFDocumentProxy,
  item: AnnotationItem,
): Promise<string | null> {
  const rect = item.rects[0]
  if (rect === undefined) {
    return null
  }
  let page
  try {
    page = await doc.getPage(item.pageIndex + 1)
  } catch {
    return null
  }
  const content = await page.getTextContent()
  const viewport = page.getViewport({ scale: 1 })
  const matched: string[] = []
  for (const textItem of content.items) {
    // The text layer mixes in markedContent nodes (no `str`); `in` narrows to
    // TextItem.
    if (!('str' in textItem) || textItem.str === '') {
      continue
    }
    if (rectsOverlap(rect, textItemNormalizedRect(textItem, viewport))) {
      matched.push(textItem.str + (textItem.hasEOL === true ? '\n' : ''))
    }
  }
  // join() puts a space after a line-break item; fold it into the newline.
  const text = matched.join(' ').replaceAll('\n ', '\n').trim()
  return text === '' ? null : text
}
