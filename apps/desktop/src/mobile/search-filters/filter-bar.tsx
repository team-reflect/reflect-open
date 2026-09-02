import { useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import { displayNoteTitle, foldTag, type NoteTagFacet } from '@reflect/core'
import { FilterChip } from './filter-chip'
import {
  EMPTY_ALL_NOTES_FILTERS,
  hasActiveFilters,
  type AllNotesFilters,
  type NoteFilterRef,
} from './filter-state'
import { NotePickerDrawer } from './note-picker-drawer'
import { TagFilterDrawer } from './tag-filter-drawer'
import { UpdatedFilterDrawer } from './updated-filter-drawer'

type OpenDrawer = 'tags' | 'linkedTo' | 'linkedBy' | 'updated' | null

interface FilterBarProps {
  filters: AllNotesFilters
  onFiltersChange: (filters: AllNotesFilters) => void
  /** Every tag in the graph — the Tags drawer's rows and chip labels. */
  facets: NoteTagFacet[]
  /** The route's tag (a tag tap landed here); rendered as its own chip. */
  routeTag: string | null
  /** Clear the route tag (Reset, or tapping its chip). */
  onClearRouteTag: () => void
}

/** The Tags chip's label: the first selected tag's display casing, plus count. */
function tagsLabel(selected: string[], facets: NoteTagFacet[]): string {
  if (selected.length === 0) {
    return 'Tags'
  }
  const first = facets.find((facet) => foldTag(facet.tag) === selected[0])?.tag ?? selected[0]!
  return selected.length === 1 ? `#${first}` : `#${first} +${selected.length - 1}`
}

/** A link chip's label: the direction word plus the chosen note. */
function linkLabel(word: string, note: NoteFilterRef | null): string {
  return note === null ? word : `${word}: ${displayNoteTitle(note.title)}`
}

/**
 * The filter badge row under the All tab's search bar (Plan 19, V1 parity):
 * horizontally scrollable chips that AND together — Pinned, Tags, Linked
 * to/by, Updated, Daily — with a Reset chip appearing once anything is
 * active. Chips with a value set open their picker drawer to change it.
 */
export function FilterBar({
  filters,
  onFiltersChange,
  facets,
  routeTag,
  onClearRouteTag,
}: FilterBarProps): ReactElement {
  const [openDrawer, setOpenDrawer] = useState<OpenDrawer>(null)
  const active = hasActiveFilters(filters) || routeTag !== null

  const patch = (changes: Partial<AllNotesFilters>): void => {
    onFiltersChange({ ...filters, ...changes })
  }

  const reset = (): void => {
    onFiltersChange(EMPTY_ALL_NOTES_FILTERS)
    if (routeTag !== null) {
      onClearRouteTag()
    }
  }

  return (
    <>
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="toolbar" aria-label="Filters">
        {active && (
          <FilterChip onClick={reset}>
            <X className="-ml-1 size-3.5" />
            Reset
          </FilterChip>
        )}
        {routeTag !== null && (
          <FilterChip active onClick={onClearRouteTag}>
            #{routeTag}
          </FilterChip>
        )}
        <FilterChip active={filters.pinned} onClick={() => patch({ pinned: !filters.pinned })}>
          Pinned
        </FilterChip>
        <FilterChip active={filters.tags.length > 0} hasMenu onClick={() => setOpenDrawer('tags')}>
          {tagsLabel(filters.tags, facets)}
        </FilterChip>
        <FilterChip
          active={filters.linkedTo !== null}
          hasMenu
          onClick={() => setOpenDrawer('linkedTo')}
        >
          <span className="max-w-40 truncate">{linkLabel('Linked to', filters.linkedTo)}</span>
        </FilterChip>
        <FilterChip
          active={filters.linkedBy !== null}
          hasMenu
          onClick={() => setOpenDrawer('linkedBy')}
        >
          <span className="max-w-40 truncate">{linkLabel('Linked by', filters.linkedBy)}</span>
        </FilterChip>
        <FilterChip
          active={filters.updated !== null}
          hasMenu
          onClick={() => setOpenDrawer('updated')}
        >
          {filters.updated?.label ?? 'Updated'}
        </FilterChip>
        <FilterChip active={filters.daily} onClick={() => patch({ daily: !filters.daily })}>
          Daily notes
        </FilterChip>
      </div>

      <TagFilterDrawer
        open={openDrawer === 'tags'}
        onOpenChange={(open) => setOpenDrawer(open ? 'tags' : null)}
        facets={facets}
        selected={filters.tags}
        onToggle={(tagKey) =>
          patch({
            tags: filters.tags.includes(tagKey)
              ? filters.tags.filter((key) => key !== tagKey)
              : [...filters.tags, tagKey],
          })
        }
      />
      <NotePickerDrawer
        open={openDrawer === 'linkedTo'}
        onOpenChange={(open) => setOpenDrawer(open ? 'linkedTo' : null)}
        title="Linked to"
        current={filters.linkedTo}
        onPick={(note) => patch({ linkedTo: note })}
      />
      <NotePickerDrawer
        open={openDrawer === 'linkedBy'}
        onOpenChange={(open) => setOpenDrawer(open ? 'linkedBy' : null)}
        title="Linked by"
        current={filters.linkedBy}
        onPick={(note) => patch({ linkedBy: note })}
      />
      <UpdatedFilterDrawer
        open={openDrawer === 'updated'}
        onOpenChange={(open) => setOpenDrawer(open ? 'updated' : null)}
        current={filters.updated}
        onApply={(updated) => patch({ updated })}
      />
    </>
  )
}
