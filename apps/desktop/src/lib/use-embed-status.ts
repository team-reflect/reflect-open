import { useEffect, useState } from 'react'
import { embedStatus, subscribeEmbedStatus, type EmbedStatus } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'

/**
 * The embedding runtime's live status (Plan 09). Polls once on mount, then
 * tracks `embed:status` events. Without a bridge (`?platform=none`) semantic
 * features stay in `uninitialized` — i.e. invisible.
 */
export function useEmbedStatus(): EmbedStatus {
  const [status, setStatus] = useState<EmbedStatus>({ status: 'uninitialized' })
  const bridgeReady = useBridgeReady()

  useEffect(() => {
    if (!bridgeReady) {
      return
    }
    let active = true
    let unlisten: (() => void) | null = null
    void embedStatus().then((current) => {
      if (active) {
        setStatus(current)
      }
    })
    void subscribeEmbedStatus((next) => {
      if (active) {
        setStatus(next)
      }
    }).then((fn) => {
      if (active) {
        unlisten = fn
      } else {
        fn()
      }
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [bridgeReady])

  return status
}
