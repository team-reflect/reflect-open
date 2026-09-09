import { browser } from 'wxt/browser'
import type { CapturedPost } from '@reflect/core/capture-envelope'
import {
  EXTRACT_POST_MESSAGE_TYPE,
  extractPostResponseSchema,
  type ExtractPostRequest,
} from './messages'

const CAPTURE_CONTENT_SCRIPT = '/content-scripts/capture-content.js'

/**
 * Read the post a permalink tab shows, through the on-demand content script
 * (`activeTab` covers the injection). Best-effort: any failure — a
 * restricted page, X markup the extractor cannot read, a logged-out render —
 * yields `undefined`, and the capture proceeds by URL alone.
 */
export async function tryExtractPostFromTab(
  tabId: number,
  id: string,
): Promise<CapturedPost | undefined> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [CAPTURE_CONTENT_SCRIPT],
    })
    const request: ExtractPostRequest = { type: EXTRACT_POST_MESSAGE_TYPE, id }
    const response: unknown = await browser.tabs.sendMessage(tabId, request)
    return extractPostResponseSchema.parse(response).post ?? undefined
  } catch (cause) {
    console.warn('the post could not be read off the page:', cause)
    return undefined
  }
}
