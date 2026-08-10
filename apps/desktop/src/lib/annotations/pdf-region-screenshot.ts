/**
 * Turn a border annotation's rect into a PNG screenshot of the covered PDF
 * region, save it as a graph asset, and build the copyable reference: the
 * screenshot wrapped in a link back to the PDF's page
 * (`[![<name>](assets/….png)](assets/….pdf#page=N)`) — the SiYuan-shaped
 * "copy reference" for rectangle annotations. Text annotations keep their
 * text link.
 *
 * The rect lives in the normalized display space (0–1 fractions of the page,
 * top-left origin); the render targets a 2x-resolution offscreen canvas so
 * the pasted screenshot stays sharp, using pdf.js's own page coordinates (the
 * same source that rasterized the canvas) so the crop aligns with the glyphs.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { annotationReference } from './annotation-reference'
import type { AnnotationItem } from './annotations-store'
import type { NormalizedRect } from './pdf-region-text'

/** The resolution multiplier for the screenshot (device px per CSS px). */
export const REGION_SCREENSHOT_RESOLUTION = 2

/** A page viewport at any scale, plus the offset-shifting `clone`. */
export interface PdfViewportRegionLike {
  width: number
  height: number
  clone(options: { offsetX: number; offsetY: number; scale?: number }): unknown
}

/** The page bits the region renderer reads and draws through. */
export interface PdfPageRegionLike {
  getViewport(options: { scale: number }): PdfViewportRegionLike
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
    promise: Promise<unknown>
  }
}

/** The pure geometry: target canvas size, scale, and the page offset. */
export interface RegionRenderSpec {
  /** Target canvas size in device pixels. */
  width: number
  height: number
  /** px per CSS px — the rendered region fills the target canvas. */
  scale: number
  /** The page offset (negative, in scaled px) that puts the region's origin at the canvas origin. */
  offsetX: number
  offsetY: number
}

/**
 * The render geometry for a normalized rect against the page's scale-1
 * viewport size: the region's top-left in CSS px, its device-pixel target
 * size at the resolution multiplier, and the scale/offsets that map the
 * region onto a canvas of that size. Pure — testable without a DOM.
 */
export function regionRenderSpec(
  rect: NormalizedRect,
  viewportWidth: number,
  viewportHeight: number,
  resolution: number,
): RegionRenderSpec {
  const x = rect[0] * viewportWidth
  const y = rect[1] * viewportHeight
  const regionWidth = Math.max(1, (rect[2] - rect[0]) * viewportWidth)
  const regionHeight = Math.max(1, (rect[3] - rect[1]) * viewportHeight)
  const width = Math.max(1, Math.round(regionWidth * resolution))
  const height = Math.max(1, Math.round(regionHeight * resolution))
  // The nominal resolution is the exact render scale; the canvas rounds to a
  // whole device pixel, leaving at most a sub-pixel edge.
  const scale = resolution
  return { width, height, scale, offsetX: -x * scale, offsetY: -y * scale }
}

/**
 * Render the region covered by `rect` onto `canvas` at the resolution
 * multiplier, returning false when the context or the render fails. The
 * offscreen canvas is sized to the region; pdf.js renders the whole page
 * through a viewport shifted so the region lands at the canvas origin.
 */
export async function renderRegion(
  page: PdfPageRegionLike,
  rect: NormalizedRect,
  canvas: HTMLCanvasElement,
  resolution = REGION_SCREENSHOT_RESOLUTION,
): Promise<boolean> {
  const viewport = page.getViewport({ scale: 1 })
  const spec = regionRenderSpec(rect, viewport.width, viewport.height, resolution)
  canvas.width = spec.width
  canvas.height = spec.height
  const context = canvas.getContext('2d')
  if (context === null) {
    return false
  }
  const renderViewport = page
    .getViewport({ scale: spec.scale })
    .clone({ offsetX: spec.offsetX, offsetY: spec.offsetY })
  try {
    await page.render({ canvasContext: context, viewport: renderViewport }).promise
  } catch {
    return false
  }
  return true
}

/** Encode the canvas as a PNG blob, or null when the encoder fails. */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png')
  })
}

/**
 * The screenshot reference: the saved image wrapped in a link back to the
 * PDF's page. The PDF path is URL-encoded per segment (like
 * {@link annotationReference}) so spaces/CJK/`#` in the filename cannot break
 * the markdown link; the screenshot path is a plain `assets/…` graph path.
 */
export function annotationScreenshotReference(
  assetPath: string,
  page: number,
  screenshotPath: string,
): string {
  const encodedPath = assetPath
    .split('/')
    .map((segment) => encodeURIComponent(segment).replaceAll('(', '%28').replaceAll(')', '%29'))
    .join('/')
  const screenshotName = screenshotPath.split('/').pop() ?? 'annotation'
  return `[![${screenshotName}](${screenshotPath})](${encodedPath}#page=${page})`
}

/** What {@link copyBorderReference} managed to copy. */
export type CopyReferenceOutcome = 'copied-screenshot' | 'copied-text'

/** The outside pieces {@link copyBorderReference} needs. */
export interface BorderReferenceDeps {
  /** The open PDF document; null means no screenshot is possible. */
  doc: PDFDocumentProxy | null
  /** Persist a pasted-style file into `assets/`; null when declined/failed. */
  saveFile: (file: File) => Promise<string | null>
  writeClipboard: (text: string) => Promise<void>
  /** Canvas factory, for tests to inject a real or mock element. */
  createCanvas?: () => HTMLCanvasElement
}

/** The default offscreen canvas for a region screenshot (pure DOM, no state). */
function createScreenshotCanvas(): HTMLCanvasElement {
  return document.createElement('canvas')
}

/**
 * Render the border rect's region and persist it as an asset, returning the
 * saved `assets/…` path — or null when no screenshot is possible (no document
 * or rect, a render/blob/save failure). The canvas is created outside the
 * try so the await-only block below never mixes DOM work with the failure
 * path.
 */
async function saveRegionScreenshot(
  item: AnnotationItem,
  deps: BorderReferenceDeps,
): Promise<string | null> {
  // A malformed sidecar can carry a non-4-element rect; the geometry math
  // reads indices defensively, so a cast to the tuple shape is safe here.
  const rect = item.rects[0] as NormalizedRect | undefined
  if (rect === undefined || deps.doc === null) {
    return null
  }
  const canvas = (deps.createCanvas ?? createScreenshotCanvas)()
  try {
    const page = await deps.doc.getPage(item.pageIndex + 1)
    if (!(await renderRegion(page, rect, canvas))) {
      return null
    }
    const blob = await canvasToPngBlob(canvas)
    if (blob === null) {
      return null
    }
    const file = new File([blob], 'annotation.png', { type: 'image/png' })
    return await deps.saveFile(file)
  } catch {
    return null
  }
}

/**
 * Copy a border annotation's reference as a linked screenshot: render the
 * rect region, save it via the asset pipeline, and put
 * `[![…](assets/….png)](assets/….pdf#page=N)` on the clipboard. When the
 * screenshot is impossible (no document, no rect, render/save failure), falls
 * back to the text link — never silently. Clipboard failures throw, so the
 * caller surfaces them.
 */
export async function copyBorderReference(
  assetPath: string,
  item: AnnotationItem,
  deps: BorderReferenceDeps,
): Promise<CopyReferenceOutcome> {
  const screenshotPath = await saveRegionScreenshot(item, deps)
  if (screenshotPath === null) {
    await deps.writeClipboard(annotationReference(assetPath, item))
    return 'copied-text'
  }
  await deps.writeClipboard(
    annotationScreenshotReference(assetPath, item.pageIndex + 1, screenshotPath),
  )
  return 'copied-screenshot'
}
