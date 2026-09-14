import { browser } from 'wxt/browser'
import { bookmarkEnvelopeSchema } from '@reflect/core/capture-envelope'
import { captureLookupResponseSchema } from './x-capture-messages'
import { enqueueCapture, flushQueue } from './flush'

export async function saveXPost(
  tabId: number,
  postId: string,
  capturedAt = new Date().toISOString(),
) {
  const tab = await browser.tabs.get(tabId)
  // Bookmarks can be created from the home timeline, not only a post permalink.
  if (tab.incognito || !tab.url || new URL(tab.url).origin !== 'https://x.com') {
    throw new Error('unsupported-tab')
  }
  // Page scripts can miss already-rendered tweets after extension installation or updates.
  // Preserve the URL even when authenticated post data cannot be captured.
  let post
  try {
    const response = captureLookupResponseSchema.parse(
      await browser.tabs.sendMessage(tabId, { type: 'x-capture:lookup', postId }, { frameId: 0 }),
    )
    const current = await browser.tabs.get(tabId)
    if (response.ok && current.url === response.pageUrl && response.post.id === postId) {
      post = response.post
    }
  } catch {
    // A missing bridge or closed tab does not erase the original save intent.
  }
  const envelope = bookmarkEnvelopeSchema.parse({
    version: 2,
    kind: 'x-bookmark',
    id: crypto.randomUUID(),
    source: 'extension',
    capturedAt,
    ...(post ? { data: post } : { postId }),
  })
  await enqueueCapture({ envelope })
  await flushQueue()
}
