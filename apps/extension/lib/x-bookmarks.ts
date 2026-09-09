import { z } from 'zod'
import { browser } from 'wxt/browser'
import {
  bookmarkEnvelopeSchema,
  postIdSchema,
  type BookmarkEnvelope,
} from '@reflect/core/capture-envelope'
import { enqueueCapture, flushQueue } from './flush'
import { readBookmarkSettings, bookmarkCaptureGeneration } from './bookmark-settings'

const requestSchema = z.object({ variables: z.object({ tweet_id: postIdSchema }) })
const MAX_REQUEST_BYTES = 65536

export interface BookmarkRequest {
  url: string
  method: string
  initiator?: string | undefined
  tabId: number
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

export function bookmarkCaptureDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Capture an explicit save or an observed request, never a server confirmation. */
export async function saveBookmark(
  postId: string,
  evidence: BookmarkEnvelope['evidence'],
  tabId: number,
  date = new Date(),
): Promise<void> {
  const generation = bookmarkCaptureGeneration()
  const allowed = (): boolean => generation === bookmarkCaptureGeneration()
  if ((await browser.tabs.get(tabId)).incognito)
    throw new Error('Bookmark capture is unavailable in incognito tabs.')
  if (
    evidence === 'request-intent' &&
    !(await browser.permissions.contains({
      permissions: ['webRequest'],
      origins: ['https://x.com/*'],
    }))
  )
    return
  const settings = await readBookmarkSettings()
  if (evidence === 'request-intent' && !settings.enabled) return
  if (!settings.targetGraphId) throw new Error('Pair Reflect before saving bookmarks.')
  if (!allowed()) return
  const envelope = bookmarkEnvelopeSchema.parse({
    version: 2,
    kind: 'x-bookmark',
    id: crypto.randomUUID(),
    source: 'extension',
    postId,
    capturedAt: date.toISOString(),
    captureDate: bookmarkCaptureDate(date),
    targetGraphId: settings.targetGraphId,
    evidence,
    presentation: settings.presentation,
  })
  await enqueueCapture({ envelope }, allowed)
  await flushQueue()
}

/** Register synchronously whenever the optional API is available. */
export function registerBookmarkObserver(): void {
  const event = browser.webRequest?.onBeforeRequest
  if (!event || event.hasListener(onBookmarkRequest)) return
  try {
    event.addListener(
      onBookmarkRequest,
      { urls: ['https://x.com/i/api/graphql/*/CreateBookmark'] },
      ['requestBody'],
    )
  } catch {
    // Optional permission may not exist yet on this worker's first start.
    void browser.permissions
      .contains({ permissions: ['webRequest'], origins: ['https://x.com/*'] })
      .then(async (granted) => {
        if (granted)
          await recordBookmarkError(
            new Error('Bookmark observer could not start. Reload the extension.'),
          )
      }, recordBookmarkError)
  }
}

/** Stop delivery of request bodies when the optional permission is revoked. */
export function unregisterBookmarkObserver(): void {
  browser.webRequest?.onBeforeRequest.removeListener(onBookmarkRequest)
}

function onBookmarkRequest(
  details: Parameters<Parameters<typeof browser.webRequest.onBeforeRequest.addListener>[0]>[0],
): undefined {
  void captureBookmarkRequest(details).catch(recordBookmarkError)
}

/** Gate body inspection as well as persistence on the current opt-in. */
export async function captureBookmarkRequest(
  details: BookmarkRequest & { timeStamp: number },
): Promise<void> {
  const generation = bookmarkCaptureGeneration()
  const settings = await readBookmarkSettings()
  if (!settings.enabled || generation !== bookmarkCaptureGeneration()) return
  const postId = parseCreateBookmark(details)
  if (postId !== undefined)
    await saveBookmark(postId, 'request-intent', details.tabId, new Date(details.timeStamp))
}

export async function recordBookmarkError(cause: unknown): Promise<void> {
  const message =
    cause instanceof Error ? cause.message : 'Bookmark capture failed; open the popup to retry.'
  await Promise.allSettled([
    browser.storage.local.set({ bookmarkError: message }),
    browser.action.setBadgeText({ text: '!' }),
  ])
}
