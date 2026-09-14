import { saveXPost } from '@/lib/x-save'
import { parseXPostId } from '@post-embed/schema'
import { z } from 'zod'
import { extensionCaptureWireSchema, postIdSchema } from '@reflect/core/capture-envelope'
import { browser } from 'wxt/browser'
import { defineBackground } from '#imports'
import { SAVE_CURRENT_PAGE_COMMAND } from '@/lib/commands'
import { enqueueCapture, flushQueue } from '@/lib/flush'
import { isFlushRequest } from '@/lib/messages'
import { readIncludePageTextPreference } from '@/lib/popup-preferences'
import { saveCapture } from '@/lib/save-capture'
import { snapshotTab } from '@/lib/snapshot-active-tab'
import { registerXPostObserver } from '@/lib/x-post-capture'
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
  const postId = tab?.url ? parseXPostId(tab.url) : undefined
  if (postId && tab?.id !== undefined) {
    await saveXPost(tab.id, postId)
    return
  }
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

export default defineBackground(() => {
  registerXPostObserver()
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id === browser.runtime.id) {
      const save = z
        .object({
          type: z.literal('x-archive:save'),
          tabId: z.number().int().nonnegative(),
          postId: postIdSchema,
        })
        .safeParse(message)
      if (save.success) {
        saveXPost(save.data.tabId, save.data.postId).then(
          () => sendResponse({ ok: true }),
          (error: unknown) =>
            sendResponse({
              ok: false,
              message: error instanceof Error ? error.message : 'capture-failed',
            }),
        )
        return true
      }
    }

    const enqueue = enqueueRequestSchema.safeParse(message)
    if (enqueue.success) {
      void enqueueCapture(enqueue.data.wire).then(
        () => sendResponse({ ok: true }),
        (cause: unknown) =>
          sendResponse({
            ok: false,
            message: cause instanceof Error ? cause.message : 'Capture failed',
          }),
      )
      return true
    }
    if (isFlushRequest(message)) {
      flushQueue().then(sendResponse, (cause: unknown) => {
        console.error('capture flush failed:', cause)
        sendResponse({ sent: 0, failed: 0, rejectedIds: [], held: -1, holdReason: 'io' })
      })
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
