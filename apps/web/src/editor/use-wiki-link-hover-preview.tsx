import { useCallback, type ReactNode } from 'react'
import type { WikilinkHoverHit } from '@meowdown/core'
import type { DateFormat } from '@reflect/core'
import { WikiLinkHoverPreview } from '@/components/wiki-link-hover-preview.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

interface WikiLinkHoverPreviewOptions {
  dateFormat: DateFormat
}

/**
 * Build the async body resolver for Meowdown's editor-scoped wiki-link hover
 * card. The whole preview is decided inside the returned promise: an existing
 * target resolves to a passive snapshot body; missing, ambiguous, unavailable,
 * and failed targets resolve to `null`, which renders no card (see
 * `NotePreviewService.previewWikiTarget`).
 */
export function useWikiLinkHoverPreview({
  dateFormat,
}: WikiLinkHoverPreviewOptions): (hit: WikilinkHoverHit) => Promise<ReactNode> {
  const { notePreview } = useCoreServices()
  return useCallback(
    async ({ target }: WikilinkHoverHit): Promise<ReactNode> => {
      const preview = await notePreview.previewWikiTarget(target)
      if (preview === null) {
        return null
      }
      return (
        <WikiLinkHoverPreview
          path={preview.path}
          markdown={preview.markdown}
          dateFormat={dateFormat}
          resolveImageUrl={preview.resolveImageUrl}
          resolveWikiEmbed={({ target: embedTarget }) => preview.resolveWikiEmbed(embedTarget)}
        />
      )
    },
    [dateFormat, notePreview],
  )
}
