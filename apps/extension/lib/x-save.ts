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
  // FIXME: `parseXPostId(tab.url)` (already used in background.ts) checks origin and path in one
  // call; then the origin check here and `permalinkPostId` in x-capture.ts are both unnecessary.
  if (tab.incognito || !tab.url || new URL(tab.url).origin !== 'https://x.com') {
    throw new Error('unsupported-tab')
  }
  const response = captureLookupResponseSchema.parse(
    await browser.tabs.sendMessage(tabId, { type: 'x-capture:lookup', postId }, { frameId: 0 }),
  )
  if (!response.ok) throw new Error(response.reason)
  const current = await browser.tabs.get(tabId)
  // FIXME: three URL-change guards (this line twice, plus `currentUrl() !== pageUrl` inside
  // `lookupCapturedPost`) and two post-id guards (`response.post.id !== postId` here and
  // `parsed.data.id !== postId` in the lookup) protect the same thing; keep one of each.
  // `documentToken` in the response is minted in x-capture.content.ts, forwarded by
  // x-capture-lookup.ts and never read by anyone: delete it.
  if (current.url !== tab.url || response.pageUrl !== tab.url || response.post.id !== postId) {
    throw new Error('page-changed')
  }
  const id = crypto.randomUUID()
  // FIXME: the envelope carries every identifier two or three times: `archive.revision` ==
  // `envelope.id`, `archive.capturedAt` == `envelope.capturedAt`, `archive.id` == `envelope.postId`
  // == `archive.data.id`. Either the envelope is `{version, kind, id, source, capturedAt, archive}`
  // or the archive drops `revision`/`capturedAt`/`id`; do not keep both.
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
