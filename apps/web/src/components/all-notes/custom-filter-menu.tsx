import { useState, type ReactElement } from 'react'
import { foldTag, isTagName, type NoteTagFacet } from '@reflect/core'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@/components/ui/combobox.tsx'
import { cn } from '@/lib/utils.ts'

interface CustomFilterMenuProps {
  /** Tags not pinned as their own tab, with non-daily note counts. */
  facets: NoteTagFacet[]
  /** The active tag when it isn't pinned (the menu owns it), else null. */
  activeTag: string | null
  onSelect: (tag: string) => void
}

/**
 * The filter group's last segment: a combobox, its search input inside the
 * popup, listing every tag that isn't pinned in settings, the original app's
 * "Custom" dropdown. The search input doubles as free entry — typing any
 * valid tag name offers a "Filter by #tag" item, so the filter isn't limited
 * to tags the facet query happened to return.
 */
export function CustomFilterMenu({
  facets,
  activeTag,
  onSelect,
}: CustomFilterMenuProps): ReactElement {
  const [query, setQuery] = useState('')

  // Accept "#book" as readily as "book" — the UI renders tags hash-prefixed,
  // so people type them that way too.
  const typed = query.trim().replace(/^#/, '')
  const counts = new Map(facets.map((facet) => [foldTag(facet.tag), facet.count]))
  const offerTyped = typed !== '' && !counts.has(foldTag(typed)) && isTagName(typed)
  const tags = facets.map((facet) => facet.tag)

  const triggerLabel = activeTag !== null ? `#${activeTag}` : 'Custom'
  let emptyMessage = 'No matching tags.'
  if (typed === '') {
    emptyMessage = 'Type a tag to filter by.'
  } else if (!isTagName(typed)) {
    emptyMessage = 'Not a valid tag name.'
  }

  return (
    <Combobox
      items={offerTyped ? [...tags, typed] : tags}
      // Tags match on their hash-prefixed label, so `#trav` and `trav` both find `#travel`.
      itemToStringLabel={(tag: string) => `#${tag}`}
      isItemEqualToValue={(tag: string, value: string) => foldTag(tag) === foldTag(value)}
      value={activeTag}
      onValueChange={(tag: string | null) => {
        if (tag !== null) {
          onSelect(tag)
        }
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      autoHighlight
    >
      <ComboboxTrigger
        aria-label={triggerLabel}
        className={cn(
          'flex h-full items-center gap-1 px-3 py-1.5 text-[13px] font-medium transition-colors duration-100',
          activeTag !== null
            ? 'bg-surface-hover text-text'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text',
        )}
      >
        {triggerLabel}
      </ComboboxTrigger>
      <ComboboxContent align="end" className="w-56" aria-label="Filter by another tag">
        <ComboboxInput showTrigger={false} placeholder="Filter by any tag…" />
        <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
        <ComboboxList>
          {(tag: string) => {
            const count = counts.get(foldTag(tag))
            return (
              <ComboboxItem key={foldTag(tag)} value={tag}>
                {count === undefined ? (
                  <span className="min-w-0 flex-1 truncate">Filter by #{tag}</span>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">#{tag}</span>
                    <span className="shrink-0 text-xs tabular-nums text-text-muted">{count}</span>
                  </>
                )}
              </ComboboxItem>
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
