import { browser } from 'wxt/browser'
import { buildWireMessage } from '@/lib/capture-message'
import { X_SETTINGS_KEY, type XSettings } from '@/lib/x-config'
import { readXPage, watchXActions } from '@/lib/x-page'
import { xPostUrl } from '@reflect/core/x-post'

declare global {
  interface Window {
    __reflectXCleanup?: () => void
  }
}

export default defineContentScript({
  registration: 'runtime',
  main(context) {
    window.__reflectXCleanup?.()
    let stopped = false
    let stopWatching = () => {}
    const timers = new Set<ReturnType<typeof setTimeout>>()

    async function start(): Promise<void> {
      const stored = (await browser.storage.local.get(X_SETTINGS_KEY))[X_SETTINGS_KEY]
      if (stopped || typeof stored !== 'object' || stored === null) return
      const settings: XSettings = {
        bookmarks: 'bookmarks' in stored && stored.bookmarks === true,
        likes: 'likes' in stored && stored.likes === true,
      }
      if (!settings.bookmarks) return
      stopWatching = watchXActions((post, trigger) => {
        if (trigger === 'like' && !settings.likes) return
        const capturedAt = new Date()
        const day = `${capturedAt.getFullYear()}-${String(capturedAt.getMonth() + 1).padStart(2, '0')}-${String(capturedAt.getDate()).padStart(2, '0')}`
        const wire = buildWireMessage({
          id: crypto.randomUUID(),
          capturedAt,
          url: xPostUrl(post.id),
          title: document.title,
          x: { trigger, day, post },
        })
        async function deliver(attempt: number): Promise<void> {
          if (stopped) return
          try {
            const response: unknown = await browser.runtime.sendMessage({ type: 'x:capture', wire })
            if (
              typeof response === 'object' &&
              response !== null &&
              'ok' in response &&
              response.ok === true
            )
              return
            if (
              typeof response === 'object' &&
              response !== null &&
              'reason' in response &&
              response.reason !== 'retry'
            )
              return
          } catch {
            /* A worker restart can interrupt an enqueue acknowledgement. */
          }
          if (attempt < 2 && !stopped) {
            const timer = setTimeout(
              () => {
                timers.delete(timer)
                void deliver(attempt + 1)
              },
              1000 * (attempt + 1),
            )
            timers.add(timer)
          }
        }
        void deliver(0)
      })
    }

    function listener(message: unknown): Promise<unknown> | undefined {
      if (typeof message !== 'object' || message === null || !('type' in message)) return
      if (message.type === 'x:stop') {
        cleanup()
        return Promise.resolve({ ok: true })
      }
      if (message.type === 'x:read' && 'url' in message && typeof message.url === 'string') {
        return Promise.resolve({ post: readXPage(message.url) })
      }
    }

    function cleanup(): void {
      stopped = true
      stopWatching()
      for (const timer of timers) clearTimeout(timer)
      browser.runtime.onMessage.removeListener(listener)
    }
    window.__reflectXCleanup = cleanup
    context.onInvalidated(cleanup)
    browser.runtime.onMessage.addListener(listener)
    void start().catch(() => {})
  },
})
