import { z } from 'zod'
import { browser } from 'wxt/browser'
import { postIdSchema } from '@reflect/core/capture-envelope'
import { saveXPost } from './x-save'
import { readBookmarkSettings } from './bookmark-settings'
import { readLikeSettings } from './like-settings'
import { reportXCaptureError } from './x-capture-status'

const requestSchema = z.object({ variables: z.object({ tweet_id: postIdSchema }) })
const MAX_REQUEST_BYTES = 65536

export interface XPostRequest {
  url: string
  method: string
  initiator?: string | undefined
  tabId: number
  timeStamp: number
  requestBody?:
    | { raw?: { bytes?: ArrayBuffer | undefined; file?: string | undefined }[] | undefined }
    | undefined
}

type XPostKind = 'x-bookmark' | 'x-like'

/** Match only supported X save operations before examining the body. */
export function getXPostKind(details: XPostRequest): XPostKind | undefined {
  if (details.method !== 'POST' || details.tabId < 0 || details.initiator !== 'https://x.com')
    return undefined
  try {
    const url = new URL(details.url)
    if (url.origin !== 'https://x.com') return undefined
    const operation = /^\/i\/api\/graphql\/[^/]+\/(CreateBookmark|FavoriteTweet)$/.exec(
      url.pathname,
    )?.[1]
    if (operation === 'CreateBookmark') return 'x-bookmark'
    if (operation === 'FavoriteTweet') return 'x-like'
    return undefined
  } catch {
    return undefined
  }
}

/** Extract a bounded string post ID from a supported request. */
export function parseXPostId(details: XPostRequest): string | undefined {
  if (getXPostKind(details) === undefined) return undefined
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

async function enabled(kind: XPostKind): Promise<boolean> {
  return (await (kind === 'x-like' ? readLikeSettings() : readBookmarkSettings())).enabled
}

/** Persist an observed save intent before attempting native delivery. */
export async function captureXPostRequest(details: XPostRequest): Promise<void> {
  const kind = getXPostKind(details)
  if (kind === undefined || !(await enabled(kind))) return
  const postId = parseXPostId(details)
  if (postId === undefined) return
  const tab = await browser.tabs.get(details.tabId).catch(() => undefined)
  if (tab === undefined || tab.incognito) return
  await saveXPost(details.tabId, postId, new Date(details.timeStamp).toISOString(), {
    kind,
    shouldAdmit: () => enabled(kind),
  })
}

/** Register synchronously so Chrome can wake the worker for either operation. */
export function registerXPostObserver(): void {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      void captureXPostRequest(details).catch((cause: unknown) => {
        console.error('X capture failed:', cause)
        void reportXCaptureError(cause).catch((error: unknown) => {
          console.error('could not report X capture failure:', error)
        })
      })
    },
    {
      urls: [
        'https://x.com/i/api/graphql/*/CreateBookmark',
        'https://x.com/i/api/graphql/*/FavoriteTweet',
      ],
    },
    ['requestBody'],
  )
}
