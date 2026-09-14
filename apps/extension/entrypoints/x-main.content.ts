import { observeXTweets } from '@post-embed/exporter/x'
import { exposeXTweets } from '@post-embed/exporter/x/bridge'
import { defineContentScript } from '#imports'
import { X_CAPTURE_CHANNEL } from '@/lib/x-capture-messages'

declare global {
  interface Window {
    __reflectXCaptureDispose?: () => void
  }
}

export default defineContentScript({
  matches: ['https://x.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    window.__reflectXCaptureDispose?.()
    const observer = observeXTweets({ capacity: 200, keepRaw: false })
    const closeBridge = exposeXTweets(observer, {
      channel: X_CAPTURE_CHANNEL,
      broadcast: false,
    })
    function dispose(): void {
      closeBridge()
      observer.dispose()
      window.removeEventListener('pagehide', onPageHide)
      if (window.__reflectXCaptureDispose === dispose) delete window.__reflectXCaptureDispose
    }
    function onPageHide(event: PageTransitionEvent): void {
      // A bfcache restore keeps the same document and must retain its observer.
      if (!event.persisted) dispose()
    }
    window.__reflectXCaptureDispose = dispose
    window.addEventListener('pagehide', onPageHide)
  },
})
