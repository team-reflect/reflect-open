import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry'
import { getOutline, subscribeOutline } from '@/editor/note-outline-store'
import { cn } from '@/lib/utils'
import { SidebarSection } from './sidebar-section'
import { useActiveHeading } from './use-active-heading'

interface OutlineSectionProps {
  /** Graph-relative path of the note whose headings to outline. */
  path: string
}

// Indentation (in rem) per heading level below H1, capped so deep nesting
// never pushes text off the narrow sidebar.
const INDENT_REM = 0.75

/**
 * The note's heading outline as a context-sidebar section. Always rendered:
 * an empty note shows a muted placeholder rather than vanishing. Headings come
 * from the live {@link file://../../editor/note-outline-store.ts}; the active
 * row tracks the viewport via {@link useActiveHeading}; a click drives
 * meowdown's `revealHeading` through the editor handle registry.
 */
export function OutlineSection({ path }: OutlineSectionProps): ReactElement {
  const headings = useSyncExternalStore(
    useCallback((listener) => subscribeOutline(path, listener), [path]),
    useCallback(() => getOutline(path), [path]),
  )
  const activeIndex = useActiveHeading(path, headings.length)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const onSelect = useCallback(
    (text: string) => {
      noteEditorHandleFor(path)?.revealHeading(text)
    },
    [path],
  )

  return (
    <SidebarSection storageKey="outline" title="Outline">
      {headings.length === 0 ? (
        <p className="px-3 py-1 text-text-muted">No headings</p>
      ) : (
        <ul className="space-y-0.5">
          {headings.map((heading, index) => {
            const active = index === activeIndex
            return (
              <li key={`${index}-${heading.slug}`}>
                <button
                  type="button"
                  ref={active ? activeRef : null}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    onSelect(heading.text)
                  }}
                  style={{ paddingLeft: `${(heading.level - 1) * INDENT_REM + 0.75}rem` }}
                  className={cn(
                    'flex w-full items-center truncate rounded-md py-1 pr-2 text-left leading-5 transition-colors duration-100',
                    active
                      ? 'bg-surface-hover text-text'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text',
                  )}
                >
                  <span className="truncate">{heading.text}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </SidebarSection>
  )
}
