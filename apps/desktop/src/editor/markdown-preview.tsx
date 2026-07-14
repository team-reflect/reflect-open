import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { MarkdownView } from '@meowdown/react'
import { useOpenExternalLink } from '@/editor/open-external-link'
import { cn } from '@/lib/utils'

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
  /** Resolve `![…](…)` sources to displayable URLs; unresolved images are skipped. */
  resolveImageUrl?: (src: string) => string | null
  /** Changes when a stable resolver's backing attachment catalog changes. */
  resolverRevision?: number
  /**
   * Navigate a clicked `[[wiki link]]` target. Omitted, links render as
   * inert chips (the palette preview's behavior). `event` carries the
   * originating click so handlers can honor ⌘-click (open in new window).
   */
  onWikiLinkClick?: (target: string, event?: MouseEvent | KeyboardEvent) => void
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
  resolverRevision = 0,
  onWikiLinkClick,
  interactive = true,
  className,
}: MarkdownPreviewProps): ReactElement {
  const openExternalLink = useOpenExternalLink()
  // Navigation stays behind a ref; attachment resolution intentionally gets a
  // new callback when its resolver/revision changes so MarkdownView rebuilds
  // stale image and embed atoms.
  const navigateRef = useRef(onWikiLinkClick)
  useEffect(() => {
    navigateRef.current = onWikiLinkClick
  })

  // Hosts either always pass the handler (chat) or never do (palette
  // preview), and a passive preview forces links inert either way. An inert
  // preview omits the handler so a chip click is a no-op rather than a dead
  // navigation.
  const navigates = interactive && onWikiLinkClick != null

  const resolveImageUrlVersioned = useCallback(
    (src: string) => resolveImageUrl?.(src) ?? undefined,
    [resolveImageUrl, resolverRevision],
  )
  const onWikilinkClickStable = useCallback(
    (payload: { target: string; event: MouseEvent | KeyboardEvent }) =>
      navigateRef.current?.(payload.target, payload.event),
    [],
  )

  return (
    <MarkdownView
      markdown={content}
      markMode="hide"
      interactive={interactive}
      resolveImageUrl={resolveImageUrlVersioned}
      {...(interactive ? { onLinkClick: openExternalLink } : {})}
      {...(navigates ? { onWikilinkClick: onWikilinkClickStable } : {})}
      className={cn('reflect-editor', className)}
    />
  )
}
