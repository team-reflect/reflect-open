import { useEffect, type ReactElement, type ReactNode } from 'react'
import type { GraphInfo } from '@reflect/core'
import { handleDeepLink } from '@/lib/deep-links/handle'
import { setDeepLinkHandler } from '@/lib/deep-links/intents'
import { useRouter } from '@/routing/router'

/**
 * Routes incoming `reflect://` URLs into the open graph session: attaches
 * this workspace's handler to the app-lifetime intake (`intents.ts`), which
 * replays anything that arrived before a graph was open. No UI — outcomes
 * surface as navigation or a toast inside {@link handleDeepLink}.
 */

interface DeepLinkProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function DeepLinkProvider({ graph, children }: DeepLinkProviderProps): ReactElement {
  const { navigate } = useRouter()

  useEffect(() => {
    // Flips on teardown (graph switch): a note resolution still in flight then
    // answers against the wrong graph's index and must not navigate.
    let stale = false
    setDeepLinkHandler((url) => {
      handleDeepLink(url, {
        navigate,
        generation: graph.generation,
        isStale: () => stale,
      }).catch((cause: unknown) => {
        console.error('deep link failed:', url, cause)
      })
    })
    return () => {
      stale = true
      setDeepLinkHandler(null)
    }
  }, [navigate, graph.generation])

  return <>{children}</>
}
