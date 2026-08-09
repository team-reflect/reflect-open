/**
 * Convert a text selection inside a pdf.js `.page` into the payload for a
 * text-type annotation.
 *
 * The browser's selection rectangles (from `Range.getClientRects()`) only
 * hit-test: the pdf.js text layer's spans are laid out by the browser's font
 * metrics, which can drift from the canvas glyphs when a font is substituted,
 * making the selection rects narrower than the text. The annotation rects
 * therefore come from pdf.js's own text coordinates
 * ({@link textItemNormalizedRect}) — the same source that rasterized the
 * canvas — so they always align with the glyphs. Each hit item's bbox is
 * clipped horizontally to the selection's extent, so a partial-line selection
 * highlights only the covered run instead of the whole text item (pdf.js text
 * items often span a whole line). The rects live in the normalized display
 * space (0–1 fractions of the page, top-left origin, y growing down), and the
 * text is the selection's own string, cleaned of control characters and
 * whitespace runs.
 */

import {
  rectsOverlap,
  textItemNormalizedRect,
  type NormalizedRect,
  type PdfTextItemLike,
  type PdfViewportLike,
} from './pdf-region-text'

/** A client-space (viewport) rectangle. */
export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
}

/** The `.page` element bits the extractor reads. */
export interface PageElementLike {
  getBoundingClientRect(): RectLike
  getAttribute(name: 'data-page-number'): string | null
}

/** The extracted payload: 0-based page, per-line normalized rects, cleaned text. */
export interface SelectionHighlight {
  pageIndex: number
  rects: NormalizedRect[]
  text: string
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Normalize each per-line client rect against the page's rect (viewport →
 * page-local fractions), dropping degenerate (zero-area) or fully-outside
 * rects and clamping the rest into the page. These are the hit-test shapes;
 * the annotation rects come from pdf.js's own text coordinates.
 */
export function normalizedSelectionRects(
  clientRects: Iterable<RectLike>,
  pageRect: RectLike,
): NormalizedRect[] {
  const pageWidth = pageRect.right - pageRect.left
  const pageHeight = pageRect.bottom - pageRect.top
  const rects: NormalizedRect[] = []
  for (const rect of clientRects) {
    const clamped: NormalizedRect = [
      clamp01((rect.left - pageRect.left) / pageWidth),
      clamp01((rect.top - pageRect.top) / pageHeight),
      clamp01((rect.right - pageRect.left) / pageWidth),
      clamp01((rect.bottom - pageRect.top) / pageHeight),
    ]
    if (clamped[2] <= clamped[0] || clamped[3] <= clamped[1]) {
      continue
    }
    rects.push(clamped)
  }
  return rects
}

/**
 * Strip control characters (PDF text can carry them) into spaces, collapse
 * whitespace runs, and trim the edges. Newlines survive — a multi-line
 * selection's text keeps its line breaks — with the spaces around them folded
 * away.
 */
function normalizedSelectionText(raw: string): string {
  let cleaned = ''
  for (const char of raw) {
    const code = char.charCodeAt(0)
    cleaned += char === '\n' ? char : code < 0x20 || code === 0x7f ? ' ' : char
  }
  return cleaned
    .replaceAll(/[^\S\n]+/g, ' ')
    .replaceAll(' \n', '\n')
    .replaceAll('\n ', '\n')
    .trim()
}

/**
 * Merge the clipped items' bboxes into one rect per visual line (items whose
 * vertical ranges overlap), spanning the union — a selection over a run of
 * words becomes one highlight box per line.
 */
function mergeIntoLines(rects: NormalizedRect[]): NormalizedRect[] {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const lines: NormalizedRect[] = []
  for (const rect of sorted) {
    const last = lines[lines.length - 1]
    if (last !== undefined && rect[1] < last[3]) {
      last[0] = Math.min(last[0], rect[0])
      last[2] = Math.max(last[2], rect[2])
      last[3] = Math.max(last[3], rect[3])
    } else {
      lines.push([...rect])
    }
  }
  return lines
}

/**
 * Build the text-annotation payload for one page: hit-test the page's text
 * items against the selection rects, clip each hit item horizontally to the
 * selection's covered extent (a partial-line selection keeps only the covered
 * run; the item's own vertical bounds stay, as they are the canvas-aligned
 * ones), and merge the clipped rects into one per line. `selectionText` is the
 * selection's own string for this page — not the hit items' strings, so a
 * partial-line selection's text is only the selected part. Returns null when
 * nothing was selected or the text cleans to empty.
 */
export function selectionToHighlight(
  selectionRects: readonly NormalizedRect[],
  textItems: readonly PdfTextItemLike[],
  viewport: PdfViewportLike,
  pageIndex: number,
  selectionText: string,
): SelectionHighlight | null {
  const normalizedItems = textItems
    .filter((item) => item.str !== '')
    .map((item) => ({ item, rect: textItemNormalizedRect(item, viewport) }))
  const clipped: NormalizedRect[] = []
  for (const { rect } of normalizedItems) {
    const covering = selectionRects.filter((selectionRect) => rectsOverlap(selectionRect, rect))
    if (covering.length === 0) {
      continue
    }
    const clipLeft = Math.min(...covering.map((selectionRect) => selectionRect[0]))
    const clipRight = Math.max(...covering.map((selectionRect) => selectionRect[2]))
    const left = Math.max(rect[0], clipLeft)
    const right = Math.min(rect[2], clipRight)
    if (right <= left) {
      continue
    }
    clipped.push([left, rect[1], right, rect[3]])
  }
  if (clipped.length === 0) {
    return null
  }
  const text = normalizedSelectionText(selectionText)
  if (text === '') {
    return null
  }
  return { pageIndex, rects: mergeIntoLines(clipped), text }
}

/**
 * The pages a selection spans, in document order, given the ordered page list
 * (the viewer's `.page` elements). A single-page selection yields that page; a
 * cross-page selection yields every page between the start and end pages,
 * inclusive, regardless of the drag direction.
 */
export function selectionPages<T extends PageElementLike>(
  startPage: T | null,
  endPage: T | null,
  allPages: readonly T[],
): T[] {
  if (startPage === null || endPage === null) {
    return []
  }
  if (startPage === endPage) {
    return [startPage]
  }
  const startIndex = allPages.indexOf(startPage)
  const endIndex = allPages.indexOf(endPage)
  if (startIndex === -1 || endIndex === -1) {
    return [startPage, endPage]
  }
  const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
  return allPages.slice(lo, hi + 1)
}
