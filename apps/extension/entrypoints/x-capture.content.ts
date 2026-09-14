import { browser } from 'wxt/browser'
import { defineContentScript } from '#imports'
import { lookupCapturedPost } from '@/lib/x-capture-lookup'
import { captureLookupRequestSchema } from '@/lib/x-capture-messages'

export default defineContentScript({
  matches: ['https://x.com/*'],
  runAt: 'document_start',
  main(ctx) {
    const documentToken = crypto.randomUUID()
    const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      message,
      sender,
      sendResponse,
    ) => {
      if (ctx.isInvalid || sender.id !== browser.runtime.id || sender.tab != null) return false
      const request = captureLookupRequestSchema.safeParse(message)
      if (!request.success) return false
      void lookupCapturedPost(request.data.postId, documentToken, () => location.href).then(
        (response) => {
          if (ctx.isValid) sendResponse(response)
        },
      )
      return true
    }
    browser.runtime.onMessage.addListener(listener)
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(listener))
  },
})
