import { z } from 'zod'
import { browser, type Browser } from 'wxt/browser'
import { X_POST_ID, xPostURL } from '@reflect/core/x-post'
import type { CaptureWireMessage } from '@reflect/core/capture-envelope'
import { enqueueCapture, flushQueue } from './flush'
import { hasXPermission } from './x-permissions'

const bookmarkBody = z.object({ variables: z.object({ tweet_id: z.string().regex(X_POST_ID) }) })
const BOOKMARK_PATH = /^\/i\/api\/graphql\/[^/]+\/CreateBookmark$/

/** Extract the bookmark ID from bounded raw request chunks. */
export function bookmarkId(
  body: Browser.webRequest.OnBeforeRequestDetails['requestBody'],
): string | null {
  if (!body || body.error || !body.raw?.length) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for (const part of body.raw) {
    if (part.file !== undefined || !part.bytes) return null
    size += part.bytes.byteLength
    if (size > 64 * 1024) return null
    chunks.push(new Uint8Array(part.bytes))
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    const parsed = bookmarkBody.safeParse(json)
    return parsed.success ? parsed.data.variables.tweet_id : null
  } catch {
    return null
  }
}

/** Enqueue bookmark intent using the existing v1 capture protocol. */
export async function captureXBookmark(
  details: Browser.webRequest.OnBeforeRequestDetails,
): Promise<void> {
  if (details.method !== 'POST') return
  const url = new URL(details.url)
  if (
    !['https://x.com', 'https://twitter.com'].includes(url.origin) ||
    !BOOKMARK_PATH.test(url.pathname) ||
    !details.initiator ||
    !['https://x.com', 'https://twitter.com'].includes(details.initiator)
  )
    return
  const postId = bookmarkId(details.requestBody)
  if (postId === null) return
  const wire: CaptureWireMessage = {
    envelope: {
      version: 1,
      id: crypto.randomUUID(),
      url: xPostURL(postId),
      title: `X post ${postId}`,
      capturedAt: new Date().toISOString(),
      source: 'extension',
    },
  }
  if (!(await hasXPermission())) return
  await enqueueCapture(wire)
  await flushQueue()
}

/** Register synchronously so a suspended worker can wake for the next request. */
export function installXBookmarkListener(): void {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      void captureXBookmark(details).catch(() => console.error('X bookmark capture failed'))
    },
    {
      urls: [
        'https://x.com/i/api/graphql/*/CreateBookmark',
        'https://twitter.com/i/api/graphql/*/CreateBookmark',
      ],
    },
    ['requestBody'],
  )
}
