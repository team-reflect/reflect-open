import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { MarkdownView } from '@meowdown/react'
import { openExternalLink } from '@/editor/open-external-link'
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
  /**
   * Navigate a clicked `[[wiki link]]` target. Omitted, links render as
   * inert chips (the palette preview's behavior). `event` carries the
   * originating click so handlers can honor ⌘-click (open in new window).
   */
  onWikiLinkClick?: (target: string, event?: MouseEvent | KeyboardEvent) => void
  /** Extra classes for the rendered root. */
  className?: string
}

export function MarkdownPreview({
  content,
  resolveImageUrl,
  onWikiLinkClick,
  className,
}: MarkdownPreviewProps): ReactElement {
  // The resolver and click handler are read through refs so a changing prop
  // never gives MarkdownView a new callback identity (which would re-render its
  // whole tree).
  const resolveRef = useRef(resolveImageUrl)
  const navigateRef = useRef(onWikiLinkClick)
  useEffect(() => {
    resolveRef.current = resolveImageUrl
    navigateRef.current = onWikiLinkClick
  })

  // Whether wiki links navigate at all is fixed by the first render: hosts
  // either always pass the handler (chat) or never do (palette preview). An
  // inert preview omits the handler so a chip click is a no-op rather than a
  // dead navigation.
  const [navigates] = useState(() => onWikiLinkClick != null)

  const resolveImageUrlStable = useCallback(
    (src: string) => resolveRef.current?.(src) ?? undefined,
    [],
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
      resolveImageUrl={resolveImageUrlStable}
      onLinkClick={openExternalLink}
      {...(navigates ? { onWikilinkClick: onWikilinkClickStable } : {})}
      className={cn('reflect-editor', className)}
    />
  )
}
