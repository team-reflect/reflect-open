import { useState, type ReactElement } from 'react'
import { foldTag, type NoteTagFacet } from '@reflect/core'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CustomFilterMenuProps {
  /** Tags not pinned as their own tab, with non-daily note counts. */
  facets: NoteTagFacet[]
  /** The active tag when it isn't pinned (the menu owns it), else null. */
  activeTag: string | null
  onSelect: (tag: string) => void
}

/**
 * The filter group's last segment: a disclosure listing every tag that isn't
 * pinned in settings (the original app's "Custom" dropdown). Same no-portal
 * idiom as the graph switcher — a fixed backdrop handles click-outside.
 * Renders nothing when there are no custom tags to offer.
 */
export function CustomFilterMenu({
  facets,
  activeTag,
  onSelect,
}: CustomFilterMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false)

  if (facets.length === 0 && activeTag === null) {
    return null
  }

  const choose = (tag: string): void => {
    setOpen(false)
    onSelect(tag)
  }

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
        }
      }}
    >
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close tag menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />
          <div
            role="menu"
            aria-label="Filter by another tag"
            className="absolute right-0 top-full z-30 mt-1.5 max-h-72 w-52 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-pop"
          >
            {facets.map((facet) => (
              <button
                key={foldTag(facet.tag)}
                type="button"
                role="menuitem"
                onClick={() => choose(facet.tag)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text"
              >
                <span className="min-w-0 flex-1 truncate text-left">#{facet.tag}</span>
                <span className="shrink-0 text-xs tabular-nums text-text-muted">
                  {facet.count}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={activeTag !== null}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex h-full items-center gap-1 px-3 py-1.5 text-[13px] font-medium transition-colors duration-100',
          activeTag !== null
            ? 'bg-surface-hover text-text'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text',
        )}
      >
        {activeTag !== null ? `#${activeTag}` : 'Custom'}
        <ChevronDown aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
      </button>
    </div>
  )
}
