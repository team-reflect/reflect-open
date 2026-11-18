import { z } from 'zod'
import { browser } from 'wxt/browser'
import { postIdSchema, type XPostKind } from '@reflect/core/capture-envelope'
import { saveXPost } from './x-save.ts'
import { readBookmarkSettings } from './bookmark-settings.ts'
import { readLikeSettings } from './like-settings.ts'

const requestSchema = z.object({ variables: z.object({ tweet_id: postIdSchema }) })
const MAX_REQUEST_BYTES = 65536

/**
 * The browser family whose `webRequest` details this build receives. Chromium
 * reports the requesting origin as `initiator`; Firefox reports the requesting
 * document as `originUrl` and never sets `initiator`. Safari builds use the
 * Chromium shape.
 */
export type WebRequestBrowser = 'chromium' | 'firefox'

/** The `webRequest.onBeforeRequest` details this module reads, as either browser sends them. */
export interface RawXPostRequest {
  url: string
  method: string
  initiator?: string | undefined
  originUrl?: string | undefined
  tabId: number
  timeStamp: number
  requestBody?: XPostRequest['requestBody']
}

/** A browser-neutral X save request. */
export interface XPostRequest {
  url: string
  method: string
  /** The origin of the page that sent the request, when the browser reports one. */
  origin: string | undefined
  tabId: number
  timeStamp: number
  requestBody?:
    | { raw?: { bytes?: ArrayBuffer | undefined; file?: string | undefined }[] | undefined }
    | undefined
}

function requestOrigin(details: RawXPostRequest, browser: WebRequestBrowser): string | undefined {
  switch (browser) {
    case 'chromium':
      return details.initiator
    case 'firefox':
      if (details.originUrl === undefined) return undefined
      try {
        return new URL(details.originUrl).origin
      } catch {
        return undefined
      }
  }
}

/** Translate one browser's `webRequest` details into the shape the capture rules read. */
export function normalizeXPostRequest(
  details: RawXPostRequest,
  browser: WebRequestBrowser,
): XPostRequest {
  return {
    url: details.url,
    method: details.method,
    origin: requestOrigin(details, browser),
    tabId: details.tabId,
    timeStamp: details.timeStamp,
    requestBody: details.requestBody,
  }
}

/** Match only supported X save operations before examining the body. */
export function getXPostKind(details: XPostRequest): XPostKind | undefined {
  if (details.method !== 'POST' || details.tabId < 0 || details.origin !== 'https://x.com')
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

/** Extract a bounded string post ID from a request body. */
export function parseXPostId(details: XPostRequest): string | undefined {
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
export function registerXPostObserver(webRequestBrowser: WebRequestBrowser): void {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      void captureXPostRequest(normalizeXPostRequest(details, webRequestBrowser)).catch(
        (cause: unknown) => {
          console.error('X capture failed:', cause)
        },
      )
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
