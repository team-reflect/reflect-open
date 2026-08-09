import { useEffect } from 'react'
import { subscribeFileChanges, type FileChange } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'

/**
 * Subscribe to the watcher's file-change events (Plan 04b) for the lifetime of
 * the component. Owns the fiddly parts of the subscription lifecycle so call
 * sites don't re-implement them:
 *
 * - events delivered after teardown are dropped (the unsubscribe is async, so
 *   a change can race the cleanup);
 * - an unlisten that resolves *after* teardown is closed immediately instead
 *   of leaking;
 * - without a bridge (browser dev) the hook is a no-op.
 *
 * The subscription follows the handler's identity: memoize the handler over
 * its real dependencies and the hook resubscribes exactly when they change.
 * Pass `null` to disable.
 */
export function useFileChanges(handler: ((changes: FileChange[]) => void) | null): void {
  const bridgeReady = useBridgeReady()
  useEffect(() => {
    if (handler === null || !bridgeReady) {
      return
    }
    let active = true
    let unlisten: (() => void) | null = null
    void subscribeFileChanges((changes) => {
      if (active) {
        handler(changes)
      }
    })
      .then((stop) => {
        if (active) {
          unlisten = stop
        } else {
          stop()
        }
      })
      .catch((cause: unknown) => {
        // A failed subscription degrades to no live updates for this mount;
        // surfaced for diagnosis rather than left as an unhandled rejection.
        console.error('file-change subscription failed:', cause)
      })
    return () => {
      active = false
      unlisten?.()
    }
  }, [bridgeReady, handler])
}
