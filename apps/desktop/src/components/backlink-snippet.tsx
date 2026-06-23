import type { ReactElement } from 'react'
import { MarkdownView } from '@meowdown/react'
import type { WikilinkClickHandler } from '@meowdown/core'
import '@meowdown/core/style.css'
import { openExternalLink } from '@/editor/open-external-link'

interface BacklinkSnippetProps {
  /** The referencing line's Markdown source. */
  text: string
  /** Navigate a clicked `[[wiki link]]` to its target. Pass a stable function. */
  onWikilinkClick: WikilinkClickHandler
  /** Resolve `![…](…)` sources to displayable URLs. Pass a stable function. */
  resolveImageUrl: (src: string) => string | undefined
}

/**
 * One referencing line in the incoming-backlinks panel, rendered as rich text
 * through meowdown's editor-free `MarkdownView`: wiki links become the editor's
 * clickable chips and inline marks render instead of raw `[[…]]` / `**…**`
 * source. The `reflect-editor` class shares the editor's chip styling; the
 * `reflect-backlink-snippet` wrapper keeps it in the panel's compact line box and
 * clamps a long or block-level line so it never towers.
 */
export function BacklinkSnippet({
  text,
  onWikilinkClick,
  resolveImageUrl,
}: BacklinkSnippetProps): ReactElement {
  return (
    <div className="reflect-backlink-snippet line-clamp-2 select-text text-xs text-text">
      <MarkdownView
        className="reflect-editor"
        markdown={text}
        onWikilinkClick={onWikilinkClick}
        onLinkClick={openExternalLink}
        resolveImageUrl={resolveImageUrl}
      />
    </div>
  )
}
