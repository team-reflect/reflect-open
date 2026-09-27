import { useXPostResolver, X_MEDIA_URL_PROTOCOLS } from '@/editor/use-x-post-resolver.ts'
import { resolveYouTubeVideo } from '@/editor/youtube-video-resolver.ts'
import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import type { ImageUrlResolver, WikiEmbedResolver } from '@meowdown/core'
import { MarkdownView } from '@meowdown/react'
import { useOpenExternalLink } from '@/editor/open-external-link.ts'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'
import { cn } from '@/lib/utils.ts'

/**
 * A read-only rendering of note markdown via @meowdown/react's `<MarkdownView>`
 * in `hide` mark mode, so previews look exactly like the note would in the
 * editor (wiki-link chips, images, and headings included) but without mounting a
 * ProseMirror editor. The view is never editable, so this can render any note
 * (protected ones included) without ever writing.
 *
 * `content` is live: changing it re-renders the preview, so one mounted preview
 * can follow a moving selection (the palette's preview pane).
 */

interface MarkdownPreviewProps {
  /** The markdown body to render (callers strip frontmatter first). */
  content: string
  /**
   * Resolve `![…](…)` sources to displayable URLs, possibly later; unresolved
   * images are skipped. Pass a stable function.
   */
  resolveImageUrl?: ImageUrlResolver
  /**
   * Classify Obsidian `![[target]]` embeds (images, file pills, note chips);
   * omitted, embeds stay literal text. Pass a stable function.
   */
  resolveWikiEmbed?: WikiEmbedResolver
  /**
   * Navigate a clicked `[[wiki link]]` target. Omitted, links render as
   * inert chips (the palette preview's behavior). `event` carries the
   * originating click so handlers can honor ⌘-click (open in new window).
   */
  onWikiLinkClick?: (options: { target: string; openInNewWindow: boolean }) => void
  /**
   * Whether rendered links, images, and task checkboxes can be activated
   * (default true). A passive preview renders no anchors, focusable controls,
   * or remote embeds.
   */
  interactive?: boolean
  /** Extra classes for the rendered root. */
  className?: string
}

export function MarkdownPreview({
  content,
  resolveImageUrl,
  resolveWikiEmbed,
  onWikiLinkClick,
  interactive = true,
  className,
}: MarkdownPreviewProps): ReactElement {
  const openExternalLink = useOpenExternalLink()
  // The click handler is read through a ref so a changing prop never gives
  // MarkdownView a new callback identity (which would re-render its whole
  // tree).
  const resolveXPost = useXPostResolver()
  const navigateRef = useRef(onWikiLinkClick)
  useEffect(() => {
    navigateRef.current = onWikiLinkClick
  })

  // Hosts either always pass the handler (chat) or never do (palette
  // preview), and a passive preview forces links inert either way. An inert
  // preview omits the handler so a chip click is a no-op rather than a dead
  // navigation.
  const navigates = interactive && onWikiLinkClick != null

  const onWikilinkClickStable = useCallback(
    (payload: { target: string; event: MouseEvent | KeyboardEvent; mod: boolean }) =>
      navigateRef.current?.({ target: payload.target, openInNewWindow: payload.mod }),
    [],
  )

  return (
    <MarkdownView
      resolveXPost={resolveXPost}
      resolveYouTubeVideo={resolveYouTubeVideo}
      mediaUrlProtocols={X_MEDIA_URL_PROTOCOLS}
      markdown={content}
      markMode="hide"
      interactive={interactive}
      resolveWikilink={resolveWikilink}
      {...(resolveImageUrl !== undefined ? { resolveImageUrl } : {})}
      {...(resolveWikiEmbed !== undefined ? { resolveWikiEmbed } : {})}
      {...(interactive ? { onLinkClick: openExternalLink } : {})}
      {...(navigates ? { onWikilinkClick: onWikilinkClickStable } : {})}
      className={cn('reflect-editor', className)}
    />
  )
}
