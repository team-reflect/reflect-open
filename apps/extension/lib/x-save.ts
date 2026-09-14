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
  const response = captureLookupResponseSchema.parse(
    await browser.tabs.sendMessage(tabId, { type: 'x-capture:lookup', postId }, { frameId: 0 }),
  )
  if (!response.ok) throw new Error(response.reason)
  if ((await browser.tabs.get(tabId)).url !== response.pageUrl) throw new Error('page-changed')
  const envelope = bookmarkEnvelopeSchema.parse({
    version: 2,
    kind: 'x-bookmark',
    id: crypto.randomUUID(),
    source: 'extension',
    capturedAt,
    data: response.post,
  })
  await enqueueCapture({ envelope })
  await flushQueue()
}
