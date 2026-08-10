import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import type { LinkClickPayload } from '@meowdown/core'
import { MarkdownView } from '@meowdown/react'
import { useOpenExternalLink } from '@/editor/open-external-link'
import { cn } from '@/lib/utils'

/** The click payload forwarded from a rendered image (mirrors meowdown's). */
export interface MarkdownImageClick {
  /** The resolved source from `![alt](src)`. */
  src: string
  /** The image alt text. */
  alt: string
  /** The originating click or touch tap, or the key press that followed a selected image. */
  event: MouseEvent | TouchEvent | KeyboardEvent
  /** Whether the platform's mod key was held during the gesture. */
  mod: boolean
}

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
  /**
   * Navigate a clicked `[[wiki link]]` target. Omitted, links render as
   * inert chips (the palette preview's behavior). `event` carries the
   * originating click so handlers can honor ⌘-click (open in new window).
   */
  onWikiLinkClick?: (options: { target: string; openInNewWindow: boolean }) => void
  /**
   * Intercept a rendered link click, replacing the default handling (the OS
   * opener for external URLs; scheme-less and asset hrefs are no-ops). The
   * handler owns forwarding what it doesn't consume — the resident preview
   * routes PDF and note links into the panel and defers the rest to
   * {@link useOpenExternalLink}.
   */
  onLinkClick?: (href: string, event: MouseEvent | KeyboardEvent, mod: boolean) => void
  /**
   * Intercept a rendered image click, replacing the default handling (the OS
   * opener for remote images). The handler owns forwarding what it doesn't
   * consume — the resident preview routes linked PDF images (`[![…](img)](
   * assets/….pdf#page=N)`) into the panel and otherwise suppresses the click.
   */
  onImageClick?: (payload: MarkdownImageClick) => void
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
  onWikiLinkClick,
  onLinkClick,
  onImageClick,
  interactive = true,
  className,
}: MarkdownPreviewProps): ReactElement {
  const openExternalLink = useOpenExternalLink()
  // The resolver and click handlers are read through refs so a changing prop
  // never gives MarkdownView a new callback identity (which would re-render its
  // whole tree).
  const resolveRef = useRef(resolveImageUrl)
  const navigateRef = useRef(onWikiLinkClick)
  const linkClickRef = useRef(onLinkClick)
  const imageClickRef = useRef(onImageClick)
  useEffect(() => {
    resolveRef.current = resolveImageUrl
    navigateRef.current = onWikiLinkClick
    linkClickRef.current = onLinkClick
    imageClickRef.current = onImageClick
  })

  // Hosts either always pass the handler (chat) or never do (palette
  // preview), and a passive preview forces links inert either way. An inert
  // preview omits the handler so a chip click is a no-op rather than a dead
  // navigation.
  const navigates = interactive && onWikiLinkClick != null

  const resolveImageUrlStable = useCallback(
    (src: string) => resolveRef.current?.(src) ?? undefined,
    [],
  )
  const onWikilinkClickStable = useCallback(
    (payload: { target: string; event: MouseEvent | KeyboardEvent; mod: boolean }) =>
      navigateRef.current?.({ target: payload.target, openInNewWindow: payload.mod }),
    [],
  )
  // A link click suppresses the default navigation and goes to the host's
  // handler when one is provided (the resident preview's panel routing);
  // otherwise it keeps the current behavior — the OS opener. Stable identity
  // so MarkdownView never re-renders its tree on a prop change.
  const onLinkClickStable = useCallback(
    (payload: LinkClickPayload) => {
      if (linkClickRef.current !== undefined) {
        payload.event.preventDefault()
        linkClickRef.current(payload.href, payload.event, payload.mod)
        return
      }
      openExternalLink(payload)
    },
    [openExternalLink],
  )
  // An image click routes to the host's handler when one is provided (the
  // resident preview's linked-PDF-image jump) and is otherwise a no-op — the
  // default handler would hand the image to the OS opener.
  const onImageClickStable = useCallback((payload: MarkdownImageClick) => {
    imageClickRef.current?.(payload)
  }, [])

  return (
    <MarkdownView
      markdown={content}
      markMode="hide"
      interactive={interactive}
      resolveImageUrl={resolveImageUrlStable}
      {...(interactive ? { onLinkClick: onLinkClickStable, onImageClick: onImageClickStable } : {})}
      {...(navigates ? { onWikilinkClick: onWikilinkClickStable } : {})}
      className={cn('reflect-editor', className)}
    />
  )
}
