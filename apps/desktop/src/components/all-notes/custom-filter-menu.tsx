import { useState, type ReactElement } from 'react'
import { foldTag, isTagName, type NoteTagFacet } from '@reflect/core'
import { ChevronDown } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface CustomFilterMenuProps {
  /** Tags not pinned as their own tab, with non-daily note counts. */
  facets: NoteTagFacet[]
  /** The active tag when it isn't pinned (the menu owns it), else null. */
  activeTag: string | null
  onSelect: (tag: string) => void
}

/**
 * The filter group's last segment: a combobox (shadcn's Popover + Command
 * pairing) listing every tag that isn't pinned in settings, the original
 * app's "Custom" dropdown. The search input doubles as free entry — typing
 * any valid tag name offers a "Filter by #tag" item, so the filter isn't
 * limited to tags the facet query happened to return.
 */
export function CustomFilterMenu({
  facets,
  activeTag,
  onSelect,
}: CustomFilterMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const choose = (tag: string): void => {
    setOpen(false)
    setQuery('')
    onSelect(tag)
  }

  // Accept "#book" as readily as "book" — the UI renders tags hash-prefixed,
  // so people type them that way too.
  const typed = query.trim().replace(/^#/, '')
  const typedKey = foldTag(typed)
  const listed = facets.some((facet) => foldTag(facet.tag) === typedKey)
  const offerTyped = typed !== '' && !listed && isTagName(typed)

  let emptyMessage = 'No matching tags.'
  if (typed === '') {
    emptyMessage = 'Type a tag to filter by.'
  } else if (!isTagName(typed)) {
    emptyMessage = 'Not a valid tag name.'
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger
        aria-pressed={activeTag !== null}
        className={cn(
          'flex h-full items-center gap-1 px-3 py-1.5 text-[13px] font-medium transition-colors duration-100',
          activeTag !== null
            ? 'bg-surface-hover text-text'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text',
        )}
      >
        {activeTag !== null ? `#${activeTag}` : 'Custom'}
        <ChevronDown aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-56 p-0">
        <Command label="Filter by another tag">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Filter by any tag…"
          />
          <CommandList>
            {/* A force-mounted item never counts as a match, so cmdk would
                show the empty state right above it — render one or the other. */}
            {offerTyped ? null : <CommandEmpty>{emptyMessage}</CommandEmpty>}
            {facets.map((facet) => (
              <CommandItem
                key={foldTag(facet.tag)}
                value={facet.tag}
                keywords={[`#${facet.tag}`]}
                data-checked={activeTag !== null && foldTag(activeTag) === foldTag(facet.tag)}
                onSelect={() => choose(facet.tag)}
              >
                <span className="min-w-0 flex-1 truncate">#{facet.tag}</span>
                <span className="shrink-0 text-xs tabular-nums text-text-muted">
                  {facet.count}
                </span>
              </CommandItem>
            ))}
            {offerTyped ? (
              <CommandItem forceMount value={`custom:${typed}`} onSelect={() => choose(typed)}>
                <span className="min-w-0 flex-1 truncate">Filter by #{typed}</span>
              </CommandItem>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
