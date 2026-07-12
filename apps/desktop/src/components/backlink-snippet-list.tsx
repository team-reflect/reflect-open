import type { ReactElement } from 'react'
import type { WikilinkClickHandler } from '@meowdown/core'
import { LazyBacklinkSnippet } from '@/components/lazy-backlink-snippet'
import type { BacklinkSnippetData } from '@/lib/group-backlinks'

interface BacklinkSnippetListProps {
  snippets: readonly BacklinkSnippetData[]
  notePath: string
  sourceTitle: string
  className: string
  onWikilinkClick: WikilinkClickHandler
  resolveImageUrl: (src: string) => string | undefined
}

/**
 * Lightweight placeholders for one source's references. Each placeholder
 * independently mounts its rich Markdown only near the note viewport, so one
 * source with hundreds of references is no more eager than hundreds of sources
 * with one reference each.
 */
export function BacklinkSnippetList({
  snippets,
  notePath,
  sourceTitle,
  className,
  onWikilinkClick,
  resolveImageUrl,
}: BacklinkSnippetListProps): ReactElement {
  return (
    <div className={className}>
      {snippets.map((snippet, index) => (
        <LazyBacklinkSnippet
          key={snippet.key}
          snippet={snippet}
          notePath={notePath}
          sourceTitle={sourceTitle}
          position={index + 1}
          total={snippets.length}
          onWikilinkClick={onWikilinkClick}
          resolveImageUrl={resolveImageUrl}
        />
      ))}
    </div>
  )
}
