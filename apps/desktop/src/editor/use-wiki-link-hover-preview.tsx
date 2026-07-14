import { useCallback, type ReactNode } from 'react'
import type { WikilinkHoverHit } from '@meowdown/core'
import { resolveExistingWikiTarget, splitFrontmatter, type DateFormat } from '@reflect/core'
import { WikiLinkHoverPreview } from '@/components/wiki-link-hover-preview'
import { readExistingNoteSource } from '@/lib/read-existing-note-source'

interface WikiLinkHoverPreviewOptions {
  generation: number | null
  graphKey: string | null
  dateFormat: DateFormat
  resolverRevision: number
  resolveImageUrlFromSource: (sourcePath: string, src: string) => string | null
  resolveAssetOpenPathFromSource: (sourcePath: string, src: string) => string | null
}

function isSvgAsset(path: string): boolean {
  return path.toLowerCase().endsWith('.svg')
}

function previewRasterUrl(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}reflect-preview=raster`
}

/**
 * Build the async body resolver for Meowdown's editor-scoped wiki-link hover
 * card. The whole preview is decided inside the returned promise: an existing
 * target resolves to a passive snapshot body; missing, ambiguous, unavailable,
 * and failed targets resolve to `null`, which renders no card. Failures are
 * swallowed into `null` rather than rejected: transient read errors (an iCloud
 * eviction, a graph switch) are expected and should not log as errors.
 */
export function useWikiLinkHoverPreview({
  generation,
  graphKey,
  dateFormat,
  resolverRevision,
  resolveImageUrlFromSource,
  resolveAssetOpenPathFromSource,
}: WikiLinkHoverPreviewOptions): (hit: WikilinkHoverHit) => Promise<ReactNode> {
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
        const resolvePreviewImageUrl = (imageSource: string): string | null => {
          const assetPath = resolveAssetOpenPathFromSource(resolution.path, imageSource)
          // SVG can contain external subresource references. The filename check
          // avoids an unnecessary request; the query also makes the asset protocol
          // enforce a sniffed raster MIME allowlist, so renamed SVG bytes cannot
          // bypass the passive card's no-network boundary.
          if (assetPath === null || isSvgAsset(assetPath)) {
            return null
          }
          const url = resolveImageUrlFromSource(resolution.path, imageSource)
          return url === null ? null : previewRasterUrl(url)
        }
        return (
          <WikiLinkHoverPreview
            path={resolution.path}
            markdown={splitFrontmatter(source).body}
            dateFormat={dateFormat}
            resolveImageUrl={resolvePreviewImageUrl}
            resolverRevision={resolverRevision}
          />
        )
      } catch {
        return null
      }
    },
    [
      dateFormat,
      generation,
      graphKey,
      resolverRevision,
      resolveAssetOpenPathFromSource,
      resolveImageUrlFromSource,
    ],
  )
}
