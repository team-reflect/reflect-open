import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import type { GraphInfo } from '@reflect/core'
import { handleDeepLink, type DeepLinkIo } from '@/lib/deep-links/handle'
import { setDeepLinkHandler } from '@/lib/deep-links/intake'
import { parseDeepLink } from '@/lib/deep-links/parse'
import { useSetPreviewPanelTarget } from '@/providers/preview-panel-provider'
import {
  beginLinkNavigationIntent,
  isCurrentLinkNavigationIntent,
} from '@/lib/windows/link-navigation-intent'
import { useRouter } from '@/routing/router'

/**
 * Routes incoming `reflect://` URLs into the open graph session: attaches
 * this workspace's handler to the app-lifetime intake (`intake.ts`), which
 * replays anything that arrived before a graph was open. No UI — outcomes
 * surface as navigation or a toast inside {@link handleDeepLink}.
 */

interface DeepLinkProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function DeepLinkProvider({ graph, children }: DeepLinkProviderProps): ReactElement {
  const { navigate, navigationRevision } = useRouter()
  // The stable preview-panel setter: `preview/open` links open the panel for
  // a note path, an app-local side-panel change rather than a navigation.
  const setPreviewPanelTarget = useSetPreviewPanelTarget()
  const openPreview = (path: string): void => {
    setPreviewPanelTarget({ kind: 'note', path })
  }

  // The graph session this provider instance currently serves. Staleness must
  // mean "the session changed", NOT "the effect re-ran": StrictMode's probe
  // cycle detaches and reattaches the handler around an in-flight note
  // resolution, and an effect-scoped flag would silently drop a link the
  // probe attach drained from the intake buffer — exactly a ⌘-clicked note
  // window's initial link. A resolution that outlives this whole instance
  // (graph switch remounts the keyed workspace) navigates a torn-down router,
  // which is a no-op — the wrong-graph homonym can never surface.
  const sessionRef = useRef(graph.generation)

  useEffect(() => {
    sessionRef.current = graph.generation
    const issued = graph.generation
    setDeepLinkHandler((url) => {
      const link = parseDeepLink(url)
      // Capture and rejected URLs do not express a navigation intent, and a
      // resident-preview link is a side-panel change rather than an addressing
      // one — none may supersede a note target that is still resolving.
      const io =
        link !== null && link.kind !== 'capture' && link.kind !== 'preview'
          ? createNavigationIo(navigate, navigationRevision, sessionRef, issued, openPreview)
          : { navigate, generation: issued, openPreview }
      handleDeepLink(url, io).catch((cause: unknown) => {
        console.error('deep link failed:', url, cause)
      })
    })
    return () => {
      setDeepLinkHandler(null)
    }
  }, [navigate, navigationRevision, graph.generation])

  return <>{children}</>
}

function createNavigationIo(
  navigate: DeepLinkIo['navigate'],
  navigationRevision: () => number,
  sessionRef: { readonly current: number },
  generation: number,
  openPreview: DeepLinkIo['openPreview'],
): DeepLinkIo {
  const linkIntent = beginLinkNavigationIntent()
  const issuedAtRevision = navigationRevision()
  return {
    navigate,
    generation,
    openPreview,
    isStale: () =>
      sessionRef.current !== generation ||
      navigationRevision() !== issuedAtRevision ||
      !isCurrentLinkNavigationIntent(linkIntent),
  }
}
