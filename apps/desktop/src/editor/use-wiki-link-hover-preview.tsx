import { useCallback, type ReactNode } from 'react'
import type { WikilinkHoverHit } from '@meowdown/core'
import {
  resolveExistingWikiTarget,
  splitFrontmatter,
  type AttachmentCatalog,
  type DateFormat,
} from '@reflect/core'
import { WikiLinkHoverPreview } from '@/components/wiki-link-hover-preview.tsx'
import { attachmentUrl, createNoteAttachments } from '@/editor/use-note-attachments.ts'
import { readExistingNoteSource } from '@/lib/read-existing-note-source.ts'
import { useAttachmentCatalog } from '@/providers/attachment-catalog-provider.tsx'

interface WikiLinkHoverPreviewOptions {
  generation: number | null
  graphKey: string | null
  dateFormat: DateFormat
}

function isSvgAsset(path: string): boolean {
  return path.toLowerCase().endsWith('.svg')
}

function previewRasterUrl(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}reflect-preview=raster`
}

/**
 * The passive card's image resolver for the note at `notePath`: local
 * raster attachments only, resolved from that note's own folder. Remote
 * images and SVGs never load in a hover card.
 */
function passiveImageResolver(
  generation: number,
  notePath: string,
  catalog: AttachmentCatalog | null,
): (source: string) => string | null {
  const { resolveAttachmentPath } = createNoteAttachments(generation, notePath, catalog)
  return (source) => {
    const assetPath = resolveAttachmentPath(source)
    // SVG can contain external subresource references. The filename check
    // avoids an unnecessary request; the query also makes the asset protocol
    // enforce a sniffed raster MIME allowlist, so renamed SVG bytes cannot
    // bypass the passive card's no-network boundary.
    if (assetPath === null || isSvgAsset(assetPath)) {
      return null
    }
    return previewRasterUrl(attachmentUrl(generation, assetPath))
  }
}

/**
 * Build the async body resolver for Meowdown's editor-scoped wiki-link hover
 * card. The whole preview is decided inside the returned promise: an existing
 * target resolves to a passive snapshot body; missing, ambiguous, unavailable,
 * and failed targets resolve to `null`, which renders no card. Failures are
 * swallowed into `null` rather than rejected: transient read errors (an iCloud
 * eviction, a graph switch) are expected and should not log as errors.
 *
 * The body's images and `![[embeds]]` resolve from the target note's folder
 * against the attachment catalog, so a new catalog re-runs the resolution.
 */
export function useWikiLinkHoverPreview({
  generation,
  graphKey,
  dateFormat,
}: WikiLinkHoverPreviewOptions): (hit: WikilinkHoverHit) => Promise<ReactNode> {
  const catalog = useAttachmentCatalog()

  return useCallback(
    async ({ target }: WikilinkHoverHit): Promise<ReactNode> => {
      if (generation === null || graphKey === null) {
        return null
      }
      try {
        const resolution = await resolveExistingWikiTarget(target, generation)
        if (resolution.kind !== 'resolved') {
          return null
        }
        const source = await readExistingNoteSource(resolution.path, generation)
        return (
          <WikiLinkHoverPreview
            path={resolution.path}
            markdown={splitFrontmatter(source).body}
            dateFormat={dateFormat}
            resolveImageUrl={passiveImageResolver(generation, resolution.path, catalog)}
            resolveWikiEmbed={
              createNoteAttachments(generation, resolution.path, catalog).resolveWikiEmbed
            }
          />
        )
      } catch {
        return null
      }
    },
    [catalog, dateFormat, generation, graphKey],
  )
}
