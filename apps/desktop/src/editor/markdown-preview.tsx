import { useCallback, useLayoutEffect, useRef, type ReactElement } from 'react'
import { MeowdownEditor, type EditorHandle } from '@meowdown/react'
import '@meowdown/core/style.css'
import '@meowdown/react/style.css'
import { cn } from '@/lib/utils'

/**
 * A read-only rendering of note markdown via @meowdown/react's
 * `<MeowdownEditor>` in `hide` mark mode, so previews look exactly like the
 * note would in the editor — wiki-link chips, images, and headings included.
 * The view is never editable, so this can render any note (protected ones
 * included) without ever writing.
 *
 * Unlike the uncontrolled note editor, `content` is **live**: the document is
 * replaced whenever it changes (silently, via the handle), so one mounted
 * preview can follow a moving selection (the ⌘K palette's preview pane).
 */

interface MarkdownPreviewProps {
  /** The markdown body to render (callers strip frontmatter first). */
  content: string
  /** Resolve `![…](…)` sources to displayable URLs; unresolved images are skipped. */
  resolveImageUrl?: (src: string) => string | null
  /**
   * Navigate a clicked `[[wiki link]]` target. Omitted, links render as
   * inert chips (the palette preview's behavior).
   */
  onWikiLinkClick?: (target: string) => void
  /** Extra classes for the rendered root. */
  className?: string
}

export function MarkdownPreview({
  content,
  resolveImageUrl,
  onWikiLinkClick,
  className,
}: MarkdownPreviewProps): ReactElement {
  const handleRef = useRef<EditorHandle>(null)

  // The resolver and click handler are read through refs so a changing prop
  // never rebuilds the editor's extensions.
  const resolveRef = useRef(resolveImageUrl)
  resolveRef.current = resolveImageUrl
  const navigateRef = useRef(onWikiLinkClick)
  navigateRef.current = onWikiLinkClick

  // Whether wiki links navigate at all is fixed by the first render — hosts
  // either always pass the handler (chat) or never do (palette preview). An
  // inert preview must not register a click handler, which would swallow chip
  // clicks.
  const navigates = useRef(onWikiLinkClick != null).current

  const resolveImageUrlStable = useCallback(
    (src: string) => resolveRef.current?.(src) ?? undefined,
    [],
  )
  const onWikilinkClickStable = useCallback(
    (payload: { target: string }) => navigateRef.current?.(payload.target),
    [],
  )

  // `content` is live; replace the document whenever it changes. `setMarkdown`
  // is silent and applies to the read-only editor.
  useLayoutEffect(() => {
    handleRef.current?.setMarkdown(content)
  }, [content])

  return (
    <MeowdownEditor
      handleRef={handleRef}
      mode="hide"
      readOnly
      initialMarkdown={content}
      resolveImageUrl={resolveImageUrlStable}
      onWikilinkClick={navigates ? onWikilinkClickStable : undefined}
      editorClassName={cn('reflect-editor', className)}
    />
  )
}
