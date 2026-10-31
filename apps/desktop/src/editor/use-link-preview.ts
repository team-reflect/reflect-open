import { useLayoutEffect, useMemo, useRef } from 'react'
import type { LinkPreviewResolver } from '@meowdown/core'
import type { LinkPreviewSession } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/** A privacy-gated, note-scoped link-preview resolver for one editor session. */
export function useLinkPreview(
  session: LinkPreviewSession | null,
): LinkPreviewResolver | undefined {
  const { linkPreview } = useCoreServices()
  const currentSessionRef = useRef<LinkPreviewSession | null>(session)
  useLayoutEffect(() => {
    currentSessionRef.current = session
    return () => {
      currentSessionRef.current = null
    }
  }, [session])

  return useMemo(() => {
    if (session === null) return
    return linkPreview.createResolver(session, () => currentSessionRef.current)
  }, [linkPreview, session])
}
