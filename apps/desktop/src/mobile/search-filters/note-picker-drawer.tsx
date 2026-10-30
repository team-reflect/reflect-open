import { useDeferredValue, useState, type ReactElement } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { parseSearchQuery } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx'
import { queryKeys } from '@/lib/query-client.ts'
import { SearchInput } from '@/mobile/search-input.tsx'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import type { NoteFilterRef } from '@reflect/app'
import { useNoteLabel } from '@/hooks/use-note-label.ts'

const PICKER_LIMIT = 20

interface NotePickerDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The drawer's title — names the link direction ("Linked to"). */
  title: string
  /** The currently chosen note, if any (shows the clear action). */
  current: NoteFilterRef | null
  onPick: (note: NoteFilterRef | null) => void
}

/**
 * The link-filter note picker (V1's note-picker modal as a bottom sheet): type
 * to search titles and bodies through the same ranked search as the list, tap
 * to choose. Blank input shows the recency feed, so recent notes are one tap.
 */
export function NotePickerDrawer({
  open,
  onOpenChange,
  title,
  current,
  onPick,
}: NotePickerDrawerProps): ReactElement {
  const { graph } = useGraph()
  const { search } = useCoreServices()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)

  const { data: hits } = useQuery({
    queryKey: queryKeys.index.mobileNotePicker(graph?.root, deferredQuery),
    queryFn: () => {
      return search.searchWithFilters(parseSearchQuery(deferredQuery), { limit: PICKER_LIMIT })
    },
    enabled: open && graph !== null,
    // Typing re-keys the query as the deferred value settles; holding the
    // previous rows avoids a "No matches" flash between keystrokes.
    placeholderData: keepPreviousData,
  })

  // Closing always drops the picker's search text — a dismissed search must
  // not resurface on the next open.
  const setOpen = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setQuery('')
    }
    onOpenChange(nextOpen)
  }

  const noteLabel = useNoteLabel()

  const pick = (note: NoteFilterRef | null): void => {
    onPick(note)
    setOpen(false)
  }

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerContent>
        <DrawerTitle>{title}</DrawerTitle>
        <DrawerBody className="px-4">
          <SearchInput
            placeholder="Find a note…"
            aria-label="Find a note"
            value={query}
            onValueChange={setQuery}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {hits !== undefined && hits.length === 0 && (
              <p className="py-6 text-center text-sm text-text-muted">No matches</p>
            )}
            {(hits ?? []).map((hit) => (
              <button
                key={hit.path}
                type="button"
                onClick={() => pick({ path: hit.path, title: hit.title })}
                className="flex h-12 w-full items-center border-b border-border text-left text-base last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate">{noteLabel(hit)}</span>
              </button>
            ))}
          </div>
          {current !== null && (
            <Button variant="ghost" onClick={() => pick(null)}>
              Clear filter
            </Button>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}
