import { useMemo } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { FileLinkResolver, WikiEmbedResolver } from '@meowdown/core'
import {
  resolveAttachmentLink,
  resolveWikiEmbedTarget,
  type AttachmentCatalog,
} from '@reflect/core'
import { useAttachmentCatalog } from '@/providers/attachment-catalog-provider.tsx'

/** How one note's images, `![[embeds]]`, and attachment links render. */
export interface NoteAttachments {
  /**
   * The graph-relative attachment a link or image destination names — the
   * path to display and open — or null for URLs, notes, and unsafe paths.
   * Destinations resolve from the note's own folder (see
   * `resolveAttachmentLink`), including the vault-root `/path` sources
   * {@link NoteAttachments.resolveWikiEmbed} hands out.
   */
  resolveAttachmentPath: (destination: string) => string | null
  /**
   * A displayable URL for an image source: http(s) as-is, a local attachment
   * as a generation-pinned `reflect-asset://` URL; null skips the image.
   */
  resolveImageUrl: (src: string) => string | null
  /**
   * Classifies an Obsidian `![[target]]` embed: an attachment renders as an
   * image or a file pill, a note as a link chip to it (note content is never
   * transcluded), and an unsafe path stays literal text.
   */
  resolveWikiEmbed: WikiEmbedResolver
  /** Claims a Markdown link to a local attachment as a file pill. Pure, per note. */
  resolveFileLink: FileLinkResolver
}

/** The `reflect-asset://` URL serving a graph-relative attachment off the UI thread. */
export function attachmentUrl(generation: number, path: string): string {
  return convertFileSrc(`${generation}/${path}`, 'reflect-asset')
}

/**
 * A resolved attachment as an image or link source: vault-root and
 * percent-encoded, so reading it back as a Markdown destination (which is
 * percent-decoded and cut at `#`/`?`) names exactly this file.
 */
function vaultRootSource(path: string): string {
  return `/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** Claims `notePath`'s links to local attachments as file pills; reads no catalog. */
function attachmentLinkClaim(notePath: string): FileLinkResolver {
  return ({ href }) => resolveAttachmentLink(notePath, href, null) !== null
}

/**
 * Attachment resolution for rendering `notePath` against `catalog` (null
 * while it loads). The non-hook form, for a surface that learns which note it
 * renders asynchronously (the wiki-link hover card); components use
 * {@link useNoteAttachments}.
 */
export function createNoteAttachments(
  generation: number | null,
  notePath: string,
  catalog: AttachmentCatalog | null,
): NoteAttachments {
  const resolveAttachmentPath = (destination: string): string | null =>
    generation === null ? null : resolveAttachmentLink(notePath, destination, catalog)
  return {
    resolveAttachmentPath,
    resolveImageUrl: (src) => {
      if (/^https?:\/\//i.test(src)) {
        return src
      }
      const path = resolveAttachmentPath(src)
      return path === null || generation === null ? null : attachmentUrl(generation, path)
    },
    resolveWikiEmbed: ({ target }) => {
      const embed = resolveWikiEmbedTarget(notePath, target, catalog)
      if (embed === null) {
        return
      }
      if (embed.kind === 'note') {
        return { kind: 'note' }
      }
      const source = vaultRootSource(embed.path)
      return embed.kind === 'image'
        ? { kind: 'image', src: source }
        : { kind: 'file', href: source }
    },
    resolveFileLink: attachmentLinkClaim(notePath),
  }
}

/**
 * {@link createNoteAttachments} for the open graph's attachment catalog. The
 * resolvers' identities change exactly when their answers can — a new note,
 * graph session, or catalog — and editors re-resolve rendered images and
 * embeds on that signal.
 */
export function useNoteAttachments(generation: number | null, notePath: string): NoteAttachments {
  const catalog = useAttachmentCatalog()
  // Per note, not per catalog: the claim never consults one.
  const resolveFileLink = useMemo(() => attachmentLinkClaim(notePath), [notePath])
  return useMemo(
    () => ({ ...createNoteAttachments(generation, notePath, catalog), resolveFileLink }),
    [catalog, generation, notePath, resolveFileLink],
  )
}
