import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import {
  defineEditorExtension,
  defineMarkMode,
  markdownToDoc,
  type TypedEditor,
} from '@meowdown/core'
import { createEditor, definePlugin, union, type Editor, type PlainExtension } from '@prosekit/core'
import { Plugin } from '@prosekit/pm/state'
import { ProseKit } from '@prosekit/react'
import '@meowdown/core/style.css'
import { cn } from '@/lib/utils'
import { defineImages } from './images'
import { defineWikiLinks } from './wiki-links'

/**
 * A read-only rendering of note markdown, built from the same meowdown
 * extension set as {@link NoteEditor} so previews look exactly like the note
 * would in the editor — wiki-link chips, images, and headings included. Syntax
 * marks are hidden (`hide` mark mode) and the view never becomes editable, so
 * this can render any note (protected ones included) without ever writing.
 *
 * Unlike the uncontrolled editor, `content` is **live**: the document is
 * replaced whenever it changes, so one mounted preview can follow a moving
 * selection (the ⌘K palette's preview pane).
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

function defineReadOnly(): PlainExtension {
  return definePlugin(new Plugin({ props: { editable: () => false } }))
}

function createPreviewEditor(
  resolveUrl: (src: string) => string | null,
  onNavigate: ((target: string) => void) | undefined,
): Editor {
  return createEditor({
    extension: union(
      defineEditorExtension(),
      defineMarkMode('hide'),
      // No handler, no plugin option: a registered callback makes the plugin
      // consume chip clicks, and an inert preview must not swallow them.
      defineWikiLinks(onNavigate ? { onNavigate } : {}),
      defineImages({ resolveUrl }),
      defineReadOnly(),
    ),
  })
}

export function MarkdownPreview({
  content,
  resolveImageUrl,
  onWikiLinkClick,
  className,
}: MarkdownPreviewProps): ReactElement {
  // The extension set is created once; the resolver and click handler are
  // read through refs so a changing prop never rebuilds the editor. Whether
  // wiki links navigate at all is fixed by the first render — hosts either
  // always pass the handler (chat) or never do (palette preview).
  const resolveRef = useRef<((src: string) => string | null) | undefined>(resolveImageUrl)
  resolveRef.current = resolveImageUrl
  const navigateRef = useRef<((target: string) => void) | undefined>(onWikiLinkClick)
  navigateRef.current = onWikiLinkClick
  const [editor] = useState(() =>
    createPreviewEditor(
      (src) => resolveRef.current?.(src) ?? null,
      onWikiLinkClick ? (target) => navigateRef.current?.(target) : undefined,
    ),
  )

  useLayoutEffect(() => {
    editor.setContent(markdownToDoc(editor as TypedEditor, content))
  }, [editor, content])

  return (
    <ProseKit editor={editor}>
      <div ref={editor.mount} className={cn('reflect-editor', className)} />
    </ProseKit>
  )
}
