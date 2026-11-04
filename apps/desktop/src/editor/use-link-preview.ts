import { useMemo } from 'react'
import type { LinkPreviewResolver } from '@meowdown/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * A privacy-gated link-preview resolver for the note at `path`.
 */
export function useLinkPreview(path: string | null): LinkPreviewResolver | undefined {
  const { linkPreview } = useCoreServices()
  return useMemo(
    () => (path === null ? undefined : linkPreview.createResolver(path)),
    [linkPreview, path],
  )
}
