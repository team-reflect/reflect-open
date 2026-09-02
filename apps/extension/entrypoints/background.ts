import { browser } from 'wxt/browser'
import { defineBackground } from '#imports'
import { SAVE_CURRENT_PAGE_COMMAND } from '@/lib/commands'
import { flushQueue } from '@/lib/flush'
import { isFlushRequest } from '@/lib/messages'
import { readIncludePageTextPreference } from '@/lib/popup-preferences'
import { saveCapture } from '@/lib/save-capture'
import { snapshotTab } from '@/lib/snapshot-active-tab'
import { flashBadge } from '@/lib/badge'
import { handlePostCaptured } from '@/lib/x/capture-post'
import { isPostCapturedMessage, isPostReleasedMessage } from '@/lib/x/messages'
import { disableXCapture, syncXContentScript, X_ORIGINS } from '@/lib/x/registration'
import { clearPostSeen } from '@/lib/x/seen'
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

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isFlushRequest(message)) {
      flushQueue().then(sendResponse, (cause: unknown) => {
        console.error('capture flush failed:', cause)
        sendResponse({ sent: 0, failed: 0, rejectedIds: [], held: -1, holdReason: 'io' })
      })
      return true // responding asynchronously
    }
    if (isPostCapturedMessage(message)) {
      handlePostCaptured(message.page).then(
        (response) => {
          if (response.saved) {
            void flashBadge()
          }
          sendResponse(response)
        },
        (cause: unknown) => {
          console.error('post capture failed:', cause)
          sendResponse({ saved: false, reason: 'rejected' })
        },
      )
      return true
    }
    if (isPostReleasedMessage(message)) {
      clearPostSeen(message.id).then(
        () => sendResponse({ ok: true }),
        (cause: unknown) => {
          console.error('post release failed:', cause)
          sendResponse({ ok: false })
        },
      )
      return true
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

  // Runtime content-script registrations do not survive an extension
  // update, so the X watcher is re-synced with the preference on install;
  // a permission revoked in chrome://extensions switches the feature off.
  browser.runtime.onInstalled.addListener(() => {
    void browser.alarms.create(RETRY_ALARM, { periodInMinutes: RETRY_PERIOD_MINUTES })
    void flushQueue()
    void syncXContentScript().catch((cause: unknown) => {
      console.error('X capture registration failed:', cause)
    })
  })
  browser.runtime.onStartup.addListener(() => {
    void flushQueue()
  })
  browser.permissions.onRemoved.addListener((removed) => {
    const origins = removed.origins ?? []
    if (origins.some((origin) => (X_ORIGINS as readonly string[]).includes(origin))) {
      void disableXCapture()
    }
  })
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) {
      void flushQueue()
    }
  })
})
