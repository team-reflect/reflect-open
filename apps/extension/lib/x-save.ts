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
  // FIXME(logic): a bookmark is now dropped whenever the page lookup fails ('not-observed' because
  // the tweet was rendered before the content scripts were injected, e.g. any x.com tab that was
  // open when the extension was installed or updated; bridge timeouts; 'page-changed'). The only
  // trace is `console.error` in x-bookmarks.ts. The previous URL-only path never lost a bookmark.
  // Decide explicitly: fall back to an envelope without `data` (the card then shows 'unavailable'
  // but the daily-note line still lands), or surface the failure to the user. Silent loss is a
  // regression.
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
