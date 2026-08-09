/**
 * Convert a text selection inside a pdf.js `.page` into the payload for a
 * text-type annotation. The rects live in the same normalized display space
 * as the highlight layer (0–1 fractions of the page, top-left origin, y
 * growing down); the text content is the selection's string with control
 * characters and whitespace runs cleaned up.
 *
 * The extractor takes structural stand-ins for the Range and the `.page`
 * element so the coordinate math is testable without a DOM.
 */

/** A normalized annotation rectangle, `[left, top, right, bottom]` in 0–1. */
export type NormalizedRect = [number, number, number, number]

/** A client-space (viewport) rectangle. */
export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
}

/** The Range/Selection bits the extractor reads. */
export interface SelectionLike {
  /** Whether the selection is a collapsed caret rather than a range. */
  collapsed: boolean
  /** Per-line client rectangles of the selection, like `Range.getClientRects()`. */
  getClientRects(): Iterable<RectLike>
  toString(): string
}

/** The `.page` element bits the extractor reads. */
export interface PageElementLike {
  getBoundingClientRect(): RectLike
  getAttribute(name: 'data-page-number'): string | null
}

/** The extracted payload: 0-based page, normalized rects, cleaned text. */
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
 * rects and clamping the rest into the page.
 */
function normalizedSelectionRects(
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
 * whitespace runs, and trim the edges — the highlight text an annotation row
 * shows.
 */
function normalizedSelectionText(raw: string): string {
  let cleaned = ''
  for (const char of raw) {
    const code = char.charCodeAt(0)
    cleaned += code < 0x20 || code === 0x7f ? ' ' : char
  }
  return cleaned.replaceAll(/\s+/g, ' ').trim()
}

/**
 * Build the text-annotation payload from a selection over a pdf page, or null
 * when there is nothing to highlight: a collapsed caret, empty text, a page
 * element without a valid page number, or no usable rects.
 */
export function selectionToHighlight(
  selection: SelectionLike,
  page: PageElementLike,
): SelectionHighlight | null {
  if (selection.collapsed) {
    return null
  }
  const text = normalizedSelectionText(selection.toString())
  if (text === '') {
    return null
  }
  const pageNumber = Number(page.getAttribute('data-page-number'))
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    return null
  }
  const pageRect = page.getBoundingClientRect()
  if (pageRect.right <= pageRect.left || pageRect.bottom <= pageRect.top) {
    return null
  }
  const rects = normalizedSelectionRects(selection.getClientRects(), pageRect)
  if (rects.length === 0) {
    return null
  }
  return { pageIndex: pageNumber - 1, rects, text }
}
