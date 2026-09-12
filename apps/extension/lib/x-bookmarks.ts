import { z } from 'zod'
import { browser } from 'wxt/browser'
import { bookmarkEnvelopeSchema, postIdSchema } from '@reflect/core/capture-envelope'
import { enqueueCapture, flushQueue } from './flush'
import { readBookmarkSettings } from './bookmark-settings'

const requestSchema = z.object({ variables: z.object({ tweet_id: postIdSchema }) })
const MAX_REQUEST_BYTES = 65536

export interface BookmarkRequest {
  url: string
  method: string
  initiator?: string | undefined
  tabId: number
  timeStamp: number
  requestBody?:
    | { raw?: { bytes?: ArrayBuffer | undefined; file?: string | undefined }[] | undefined }
    | undefined
}

/** Extract only a bounded post ID from an observed bookmark request. */
export function parseCreateBookmark(details: BookmarkRequest): string | undefined {
  if (details.method !== 'POST' || details.tabId < 0 || details.initiator !== 'https://x.com')
    return undefined
  let url: URL
  try {
    url = new URL(details.url)
  } catch {
    return undefined
  }
  if (
    url.origin !== 'https://x.com' ||
    !/^\/i\/api\/graphql\/[^/]+\/CreateBookmark$/.test(url.pathname)
  )
    return undefined
  const parts = details.requestBody?.raw
  if (!parts?.length || parts.some((part) => part.file !== undefined || part.bytes === undefined))
    return undefined
  const length = parts.reduce((total, part) => total + (part.bytes?.byteLength ?? 0), 0)
  if (length === 0 || length > MAX_REQUEST_BYTES) return undefined
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    if (part.bytes === undefined) return undefined
    bytes.set(new Uint8Array(part.bytes), offset)
    offset += part.bytes.byteLength
  }
  try {
    const parsed = requestSchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    )
    return parsed.success ? parsed.data.variables.tweet_id : undefined
  } catch {
    return undefined
  }
}

/** Queue an observed bookmark request; a request is a save intent, not X's confirmation. */
export async function captureBookmarkRequest(details: BookmarkRequest): Promise<void> {
  if (!(await readBookmarkSettings()).enabled) return
  const postId = parseCreateBookmark(details)
  if (postId === undefined) return
  if ((await browser.tabs.get(details.tabId)).incognito) return
  const envelope = bookmarkEnvelopeSchema.parse({
    version: 2,
    kind: 'x-bookmark',
    id: crypto.randomUUID(),
    source: 'extension',
    postId,
    capturedAt: new Date(details.timeStamp).toISOString(),
  })
  await enqueueCapture({ envelope })
  await flushQueue()
}

/** Must run synchronously at worker start so Chrome can wake the worker for requests. */
export function registerBookmarkObserver(): void {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      void captureBookmarkRequest(details).catch((cause: unknown) => {
        console.error('bookmark capture failed:', cause)
      })
    },
    { urls: ['https://x.com/i/api/graphql/*/CreateBookmark'] },
    ['requestBody'],
  )
}
