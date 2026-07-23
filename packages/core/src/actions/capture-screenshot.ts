import { isAppError } from '../errors'
import { captureImageFetch, readAsset } from '../graph/commands'
import { SCREENSHOT_MAX_DIM } from './capture-drain'
import type { CaptureIdentity } from './capture-identity'
import type { CaptureNoteMeta } from './capture-note'
import type { PageMeta } from './meta-scrape'

/**
 * The capture's screenshot pixels for the AI call, base64 — `undefined` when
 * the capture has none or the asset vanished (a race with a user delete is
 * not an enrichment failure).
 */
export async function readCaptureScreenshot(
  meta: CaptureNoteMeta,
  generation: number,
): Promise<string | undefined> {
  if (!meta.captureScreenshot) {
    return undefined
  }
  try {
    return await readAsset(meta.captureScreenshot, generation)
  } catch (cause) {
    if (!isAppError(cause) || cause.kind !== 'notFound') {
      throw cause
    }
    return undefined
  }
}

/**
 * Fetch the page's own preview image (its scraped `og:image`) into the graph
 * as the capture's screenshot asset — the stand-in pixels for shares that
 * carry none of their own (the iOS share sheet, unlike the Chrome extension,
 * cannot screenshot the host app). Returns the asset path to stamp, or
 * `null` when the capture already has a screenshot, the scrape produced no
 * image, or the fetch failed — bonus context only, never a blocker, and the
 * lossy metadata checkpoint deliberately does not retry it.
 */
export async function fetchPreviewScreenshot(
  pageMeta: PageMeta | null,
  meta: CaptureNoteMeta,
  identity: CaptureIdentity,
  generation: number,
): Promise<string | null> {
  if (meta.captureScreenshot !== undefined || !pageMeta?.image) {
    return null
  }
  try {
    await captureImageFetch(pageMeta.image, identity.assetPath, SCREENSHOT_MAX_DIM, generation)
    return identity.assetPath
  } catch {
    return null
  }
}
