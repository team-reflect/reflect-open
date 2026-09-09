import { z } from 'zod'
import {
  bookmarkSettingsSchema,
  readBookmarkSettings,
  writeBookmarkSettings,
  invalidateBookmarkCapture,
} from '@/lib/bookmark-settings'
import { extensionCaptureWireSchema, postIdSchema } from '@reflect/core/capture-envelope'
import {
  registerBookmarkObserver,
  unregisterBookmarkObserver,
  saveBookmark,
  recordBookmarkError,
} from '@/lib/x-bookmarks'
import { browser } from 'wxt/browser'
import { defineBackground } from '#imports'
import { SAVE_CURRENT_PAGE_COMMAND } from '@/lib/commands'
import { discardQueuedCaptures, enqueueCapture, flushQueue } from '@/lib/flush'
import { isFlushRequest } from '@/lib/messages'
import { readIncludePageTextPreference } from '@/lib/popup-preferences'
import { saveCapture } from '@/lib/save-capture'
import { snapshotTab } from '@/lib/snapshot-active-tab'
import { tryExtractPageText } from './popup/extract-page-text'

/**
 * The MV3 service worker owns retries and the shortcut fast path. Every
 * capture is persisted before a flush starts, so nothing depends on this
 * worker's (or the popup's) lifetime. Retries ride four triggers: every flush
 * ping, the keyboard shortcut, browser startup, and a coarse alarm for the
 * "Reflect installed an hour later" case.
 */

const RETRY_ALARM = 'capture-retry'
const RETRY_PERIOD_MINUTES = 15

async function saveTabWithDefaults(tab: Parameters<typeof snapshotTab>[0]): Promise<void> {
  const captured = await snapshotTab(tab)
  if (captured.status !== 'ready') {
    return
  }
  const contentText = (await readIncludePageTextPreference())
    ? await tryExtractPageText(captured.tabId, captured.page.url)
    : undefined
  const outcome = await saveCapture(
    {
      ...captured.page,
      contentText,
      id: crypto.randomUUID(),
      capturedAt: new Date(),
    },
    flushQueue,
  )
  if (outcome.fate === 'rejected') {
    console.error('shortcut capture rejected by Reflect host')
  }
}

const enqueueRequestSchema = z.object({
  type: z.literal('enqueue'),
  wire: extensionCaptureWireSchema,
})
const bookmarkRequestSchema = z.object({
  type: z.literal('save-bookmark'),
  postId: postIdSchema,
  tabId: z.number().int().nonnegative(),
})
const settingsRequestSchema = z.object({
  type: z.literal('bookmark-settings'),
  settings: bookmarkSettingsSchema,
})
const discardRequestSchema = z.object({ type: z.literal('discard-capture'), id: z.guid() })

export default defineBackground(() => {
  registerBookmarkObserver()
  browser.permissions.onAdded.addListener(registerBookmarkObserver)
  browser.permissions.onRemoved.addListener(() => {
    invalidateBookmarkCapture()
    unregisterBookmarkObserver()
    void readBookmarkSettings()
      .then((settings) => writeBookmarkSettings({ ...settings, enabled: false }))
      .catch(recordBookmarkError)
  })
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const enqueue = enqueueRequestSchema.safeParse(message)
    const bookmark = bookmarkRequestSchema.safeParse(message)
    const settings = settingsRequestSchema.safeParse(message)
    let task: Promise<void> | undefined
    if (enqueue.success) task = enqueueCapture(enqueue.data.wire)
    else if (bookmark.success)
      task = saveBookmark(bookmark.data.postId, 'manual', bookmark.data.tabId)
    else if (settings.success) task = writeBookmarkSettings(settings.data.settings)
    if (task) {
      void task.then(
        () => sendResponse({ ok: true }),
        (cause: unknown) =>
          sendResponse({
            ok: false,
            message: cause instanceof Error ? cause.message : 'Capture failed',
          }),
      )
      return true
    }
    const discard = discardRequestSchema.safeParse(message)
    if (discard.success) {
      void discardQueuedCaptures(discard.data.id).then(sendResponse, () =>
        sendResponse({ error: 'Could not discard captures' }),
      )
      return true
    }
    if (isFlushRequest(message)) {
      flushQueue(z.object({ retryParked: z.literal(true) }).safeParse(message).success).then(
        sendResponse,
        (cause: unknown) => {
          console.error('capture flush failed:', cause)
          sendResponse({ sent: 0, failed: 0, rejectedIds: [], held: -1, holdReason: 'io' })
        },
      )
      return true // responding asynchronously
    }
    return false
  })

  browser.commands.onCommand.addListener((command, tab) => {
    if (command === SAVE_CURRENT_PAGE_COMMAND) {
      void saveTabWithDefaults(tab).catch((cause: unknown) => {
        console.error('shortcut capture failed:', cause)
      })
    }
  })

  browser.runtime.onInstalled.addListener(() => {
    void browser.alarms.create(RETRY_ALARM, { periodInMinutes: RETRY_PERIOD_MINUTES })
    void flushQueue()
  })
  browser.runtime.onStartup.addListener(() => {
    void flushQueue()
  })
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) {
      void flushQueue()
    }
  })
})
