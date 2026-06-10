import type { ReactElement } from 'react'
import { foldTag, type NoteTagFacet } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'
import { CustomFilterMenu } from './custom-filter-menu'
import { FilterTab } from './filter-tab'

interface AllNotesFiltersProps {
  /** The active tag filter (`null` = the All tab). */
  tag: string | null
  /** Every tag carried by a non-daily note, for the Custom menu. */
  facets: NoteTagFacet[]
  onSelect: (tag: string | null) => void
}

/**
 * The All Notes filter bar: an All tab, one tab per pinned tag (the
 * `allNotesFilterTags` setting), and a Custom menu offering every remaining
 * tag. Tag matching is case-insensitive throughout, same as the `#tag`
 * search token.
 */
export function AllNotesFilters({ tag, facets, onSelect }: AllNotesFiltersProps): ReactElement {
  const { settings } = useSettings()

  // The setting is user-edited JSON — dedupe case-insensitively and drop
  // blanks so a hand-edited document can't render twin or empty tabs.
  const pinned: string[] = []
  const pinnedKeys = new Set<string>()
  for (const entry of settings.allNotesFilterTags) {
    const trimmed = entry.trim()
    const key = foldTag(trimmed)
    if (key !== '' && !pinnedKeys.has(key)) {
      pinnedKeys.add(key)
      pinned.push(trimmed)
    }
  }

  const activeKey = tag === null ? null : foldTag(tag)
  const customTag = tag !== null && !pinnedKeys.has(foldTag(tag)) ? tag : null
  const customFacets = facets.filter((facet) => !pinnedKeys.has(foldTag(facet.tag)))

  return (
    <div
      role="group"
      aria-label="Filter by tag"
      className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
    >
      <FilterTab label="All" active={tag === null} onClick={() => onSelect(null)} />
      {pinned.map((pinnedTag) => (
        <FilterTab
          key={foldTag(pinnedTag)}
          label={`#${pinnedTag}`}
          active={activeKey === foldTag(pinnedTag)}
          onClick={() => onSelect(pinnedTag)}
        />
      ))}
      <CustomFilterMenu facets={customFacets} activeTag={customTag} onSelect={onSelect} />
    </div>
  )
}
