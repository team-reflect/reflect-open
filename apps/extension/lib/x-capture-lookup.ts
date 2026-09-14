import { X_CAPTURE_CHANNEL } from './x-capture'
import { requestXTweet } from '@post-embed/exporter/x/bridge'
import { capturedPostSchema, type CaptureLookupResponse } from './x-capture-messages'

/** Look up one observed snapshot without crossing into privileged browser APIs. */
export async function lookupCapturedPost(
  postId: string,
  currentUrl: () => string,
): Promise<CaptureLookupResponse> {
  const pageUrl = currentUrl()
  try {
    const entry = await requestXTweet(postId, {
      channel: X_CAPTURE_CHANNEL,
      waitMs: 3000,
      timeoutMs: 2000,
    })
    if (!entry) return { ok: false, reason: 'not-observed' }
    const parsed = capturedPostSchema.safeParse(entry.post)
    if (!parsed.success) return { ok: false, reason: 'invalid-snapshot' }
    if (parsed.data.id !== postId) return { ok: false, reason: 'wrong-post' }
    return { ok: true, pageUrl, post: parsed.data }
  } catch {
    return { ok: false, reason: 'lookup-failed' }
  }
}
