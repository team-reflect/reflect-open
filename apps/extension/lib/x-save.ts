import { browser } from 'wxt/browser'
import { createArchivedPost } from '@reflect/core/x-archive'
import { bookmarkEnvelopeSchema } from '@reflect/core/capture-envelope'
import { captureLookupResponseSchema } from './x-capture-messages'
import { enqueueArchivedCapture, flushArchivedCaptures } from './x-archive-queue'

export async function saveXPost(
  tabId: number,
  postId: string,
  capturedAt = new Date().toISOString(),
) {
  const tab = await browser.tabs.get(tabId)
  if (tab.incognito || !tab.url || new URL(tab.url).origin !== 'https://x.com') {
    throw new Error('unsupported-tab')
  }
  const response = captureLookupResponseSchema.parse(
    await browser.tabs.sendMessage(tabId, { type: 'x-capture:lookup', postId }, { frameId: 0 }),
  )
  if (!response.ok) throw new Error(response.reason)
  const current = await browser.tabs.get(tabId)
  if (current.url !== tab.url || response.pageUrl !== tab.url || response.post.id !== postId) {
    throw new Error('page-changed')
  }
  const id = crypto.randomUUID()
  const archive = createArchivedPost(response.post, capturedAt, id)
  const envelope = bookmarkEnvelopeSchema.parse({
    version: 2,
    kind: 'x-bookmark',
    id,
    source: 'extension',
    postId,
    capturedAt,
    archive,
  })
  await enqueueArchivedCapture(envelope)
  await flushArchivedCaptures()
}
