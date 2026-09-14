import { browser } from 'wxt/browser'
import { defineContentScript } from '#imports'
import { xPostSchema } from '@reflect/core/x-archive'
import { requestXTweet } from '@post-embed/exporter/x/bridge'
import {
  captureLookupRequestSchema,
  X_CAPTURE_CHANNEL,
  type CaptureLookupResponse,
} from '@/lib/x-capture-messages'

export default defineContentScript({
  matches: ['https://x.com/*'],
  runAt: 'document_start',
  main(ctx) {
    const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      message,
      sender,
      sendResponse,
    ) => {
      if (ctx.isInvalid || sender.id !== browser.runtime.id || sender.tab != null) return false
      const request = captureLookupRequestSchema.safeParse(message)
      if (!request.success) return false
      void lookupCapturedPost(request.data.postId).then((response) => {
        if (ctx.isValid) sendResponse(response)
      })
      return true
    }
    browser.runtime.onMessage.addListener(listener)
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(listener))
  },
})

/** Look up one observed snapshot without crossing into privileged browser APIs. */

async function lookupCapturedPost(postId: string): Promise<CaptureLookupResponse> {
  const pageUrl = location.href
  try {
    const entry = await requestXTweet(postId, {
      channel: X_CAPTURE_CHANNEL,
      waitMs: 3000,
      timeoutMs: 2000,
    })
    if (!entry) return { ok: false, reason: 'not-observed' }
    const parsed = xPostSchema.safeParse(entry.post)
    if (!parsed.success) return { ok: false, reason: 'invalid-snapshot' }
    if (parsed.data.id !== postId) return { ok: false, reason: 'wrong-post' }
    return { ok: true, pageUrl, post: parsed.data }
  } catch {
    return { ok: false, reason: 'lookup-failed' }
  }
}
