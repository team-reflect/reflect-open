import { useMemo } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { FileLinkResolver, ImageUrlResolver, WikiEmbedResolver } from '@meowdown/core'
import {
  resolveAttachmentLink,
  resolveWikiEmbedTarget,
  type AttachmentCatalog,
} from '@reflect/core'
import { loadAttachmentCatalog, peekAttachmentCatalog } from '@/lib/attachment-catalog.ts'

/** How one note's images, `![[embeds]]`, and attachment links render. */
export interface NoteAttachments {
  /**
   * The graph-relative attachment a link or image destination names — the
   * path to display and open — or null for URLs, notes, and unsafe paths.
   * Reads the catalog as loaded so far.
   */
  resolveAttachmentPath: (destination: string) => string | null
  /**
   * A displayable URL for an image source: http(s) as-is, a local attachment
   * as a generation-pinned `reflect-asset://` URL. Answers synchronously once
   * the catalog is loaded and waits for it before that.
   */
  resolveImageUrl: ImageUrlResolver
  /** Classifies an Obsidian `![[target]]` embed. */
  resolveWikiEmbed: WikiEmbedResolver
  /** Claims a Markdown link to a local attachment as a file pill. */
  resolveFileLink: FileLinkResolver
}

/** The `reflect-asset://` URL serving a graph-relative attachment off the UI thread. */
export function attachmentUrl(generation: number, path: string): string {
  return convertFileSrc(`${generation}/${path}`, 'reflect-asset')
}

/**
 * An attachment renders as an image or a file pill, a note as a link chip to
 * it (note content is never transcluded), and an unsafe path stays literal.
 */
const resolveWikiEmbed: WikiEmbedResolver = ({ target }) => {
  const embed = resolveWikiEmbedTarget(target)
  if (embed === null) {
    return
  }
  if (embed.kind === 'note') {
    return { kind: 'note' }
  }
  return embed.kind === 'image'
    ? { kind: 'image', src: embed.source }
    : { kind: 'file', href: embed.source }
}

/** Attachment resolution for rendering `notePath` in graph session `generation`. */
export function createNoteAttachments(
  generation: number | null,
  notePath: string,
): NoteAttachments {
  const resolvePath = (destination: string, catalog: AttachmentCatalog | null): string | null =>
    generation === null ? null : resolveAttachmentLink(notePath, destination, catalog)
  return {
    resolveAttachmentPath: (destination) =>
      resolvePath(destination, generation === null ? null : peekAttachmentCatalog(generation)),
    resolveImageUrl: (src) => {
      if (/^https?:\/\//i.test(src)) {
        return src
      }
      if (generation === null) {
        return
      }
      const url = (catalog: AttachmentCatalog | null): string | undefined => {
        const path = resolvePath(src, catalog)
        return path === null ? undefined : attachmentUrl(generation, path)
      }
      const catalog = peekAttachmentCatalog(generation)
      return catalog === null
        ? loadAttachmentCatalog(generation).then(url, () => url(null))
        : url(catalog)
    },
    resolveWikiEmbed,
    resolveFileLink: ({ href }) => resolveAttachmentLink(notePath, href, null) !== null,
  }
}

/** {@link createNoteAttachments} memoized per note and graph session. */
export function useNoteAttachments(generation: number | null, notePath: string): NoteAttachments {
  return useMemo(() => createNoteAttachments(generation, notePath), [generation, notePath])
}
