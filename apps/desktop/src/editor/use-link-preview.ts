import { useLayoutEffect, useMemo, useRef } from 'react'
import type { LinkPreviewResolver } from '@meowdown/core'
import { createNoteLinkPreviewResolver, type LinkPreviewSession } from './link-preview-resolver'

/** A privacy-gated, note-scoped link-preview resolver for one editor session. */
export function useLinkPreview(
  session: LinkPreviewSession | null,
): LinkPreviewResolver | undefined {
  const currentSessionRef = useRef<LinkPreviewSession | null>(session)
  useLayoutEffect(() => {
    currentSessionRef.current = session
    return () => {
      currentSessionRef.current = null
    }
  }, [session])

  return useMemo(() => {
    if (session === null) return
    return createNoteLinkPreviewResolver(session, () => currentSessionRef.current)
  }, [session])
}
