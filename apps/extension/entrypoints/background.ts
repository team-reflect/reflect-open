import { browser } from 'wxt/browser'
import { defineBackground } from '#imports'
import { flushQueue } from '@/lib/flush'
import { isFlushRequest } from '@/lib/messages'

/**
 * The MV3 service worker: flushes the capture queue to the native host. It
 * never composes captures — the popup persists them to storage first and
 * pings `flush`, so nothing depends on this worker's (or the popup's)
 * lifetime. Retries ride three triggers: every flush ping, browser startup,
 * and a coarse alarm for the "Reflect installed an hour later" case.
 */

const RETRY_ALARM = 'capture-retry'
const RETRY_PERIOD_MINUTES = 15

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isFlushRequest(message)) {
      flushQueue().then(sendResponse, (cause: unknown) => {
        console.error('capture flush failed:', cause)
        sendResponse({ sent: 0, failed: 0, rejectedIds: [], held: -1, holdReason: 'io' })
      })
      return true // responding asynchronously
    }
    return false
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
