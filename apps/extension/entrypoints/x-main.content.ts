import { observeXTweets } from '@post-embed/exporter/x'
import { exposeXTweets } from '@post-embed/exporter/x/bridge'
import { defineContentScript } from '#imports'
import { X_CAPTURE_CHANNEL } from '@/lib/x-capture-messages'

declare global {
  interface Window {
    __reflectXCaptureDispose?: () => void
  }
}

function getDispose(): VoidFunction | undefined {
  if (typeof window === 'undefined') return
  return window.__reflectXCaptureDispose
}

function setDispose(dispose: VoidFunction): void {
  if (typeof window === 'undefined') return
  window.__reflectXCaptureDispose = dispose
}

function clearDispose(): void {
  if (typeof window === 'undefined') return
  delete window.__reflectXCaptureDispose
}

export default defineContentScript({
  matches: ['https://x.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    getDispose()?.()
    const observer = observeXTweets({ capacity: 200, keepRaw: false })
    const closeBridge = exposeXTweets(observer, {
      channel: X_CAPTURE_CHANNEL,
      broadcast: false,
    })
    function dispose(): void {
      closeBridge()
      observer.dispose()
      window.removeEventListener('pagehide', onPageHide)
      if (getDispose() === dispose) clearDispose()
    }
    function onPageHide(event: PageTransitionEvent): void {
      // A bfcache restore keeps the same document and must retain its observer.
      if (!event.persisted) dispose()
    }
    setDispose(dispose)
    window.addEventListener('pagehide', onPageHide)
  },
})
