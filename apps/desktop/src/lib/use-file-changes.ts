import { useEffect, useMemo, useState } from 'react'
import { hasBridge, subscribeFileChanges, type FileChange } from '@reflect/core'

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
 * Pass `null` to disable. The return value becomes true once the current
 * handler's native subscription is installed (and is immediately true when
 * disabled or running without a bridge), so consumers that cannot tolerate a
 * pre-subscription race can wait before starting their work.
 */
export function useFileChanges(handler: ((changes: FileChange[]) => void) | null): boolean {
  const bridgeAvailable = hasBridge()
  const subscription = useMemo(
    () => ({ bridgeAvailable, handler }),
    [bridgeAvailable, handler],
  )
  const [readySubscription, setReadySubscription] = useState<typeof subscription | null>(null)

  useEffect(() => {
    const currentHandler = subscription.handler
    if (currentHandler === null || !subscription.bridgeAvailable) {
      return
    }
    let active = true
    let unlisten: (() => void) | null = null
    void subscribeFileChanges((changes) => {
      if (active) {
        currentHandler(changes)
      }
    })
      .then((stop) => {
        if (active) {
          unlisten = stop
          setReadySubscription(subscription)
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
  }, [subscription])

  return handler === null || !bridgeAvailable || readySubscription === subscription
}
