import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  errorMessage,
  hasBridge,
  isMobilePlatform,
  subscribeGraphOpenRequested,
  takeGraphOpenRequest,
  type AppPlatform,
} from '@reflect/core'

interface DockGraphOpenRequestsOptions {
  platform: AppPlatform
  openRecent: (root: string) => Promise<boolean>
}

interface DockGraphOpenRequests {
  drainDockGraphOpenRequests: () => Promise<boolean>
  hasOpenedDockGraphOpenRequest: () => boolean
}

/**
 * Drains graph folders dropped on the macOS Dock icon.
 *
 * Rust queues native open-document requests because they can arrive before the
 * React tree is mounted. This hook subscribes to later Dock drops and exposes a
 * drain function so launch bootstrap can prioritize a queued Dock folder over
 * reopening the most recent graph.
 */
export function useDockGraphOpenRequests({
  platform,
  openRecent,
}: DockGraphOpenRequestsOptions): DockGraphOpenRequests {
  const hasOpenedDockGraphOpenRequestRef = useRef(false)

  const drainDockGraphOpenRequests = useCallback(async (): Promise<boolean> => {
    if (!hasBridge() || isMobilePlatform(platform)) {
      return false
    }

    let opened = false
    for (;;) {
      const root = await takeGraphOpenRequest()
      if (root === null) {
        return opened
      }
      opened = true
      hasOpenedDockGraphOpenRequestRef.current = true
      await openRecent(root)
    }
  }, [openRecent, platform])

  const hasOpenedDockGraphOpenRequest = useCallback((): boolean => {
    return hasOpenedDockGraphOpenRequestRef.current
  }, [])

  useEffect(() => {
    if (!hasBridge() || isMobilePlatform(platform)) {
      return
    }

    let active = true
    let unlisten: (() => void) | null = null
    void subscribeGraphOpenRequested(() => {
      if (active) {
        void drainDockGraphOpenRequests()
      }
    })
      .then((unsubscribe) => {
        if (active) {
          unlisten = unsubscribe
          void drainDockGraphOpenRequests()
        } else {
          unsubscribe()
        }
      })
      .catch((err: unknown) => {
        console.error('dock graph open request subscription failed:', errorMessage(err))
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [drainDockGraphOpenRequests, platform])

  return useMemo(
    () => ({ drainDockGraphOpenRequests, hasOpenedDockGraphOpenRequest }),
    [drainDockGraphOpenRequests, hasOpenedDockGraphOpenRequest],
  )
}
