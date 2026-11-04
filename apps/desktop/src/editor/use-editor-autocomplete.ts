import { useCallback } from 'react'
import type {
  TagItem,
  TagSearchHandler,
  WikilinkItem,
  WikilinkSearchHandler,
} from '@meowdown/react'
import { useGraphInfo } from '@/providers/graph-provider.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/** The `[[` and `#` autocomplete search handlers a {@link NoteEditor} wires up. */
export interface EditorAutocomplete {
  /** Search notes for the `[[` menu: ranked suggestions plus a trailing "Create" row. */
  onWikilinkSearch: WikilinkSearchHandler
  /** Search tags for the `#` menu, most-used first. */
  onTagSearch: TagSearchHandler
}

/**
 * The editor's `[[` and `#` autocomplete. meowdown owns the menu UI; the rows
 * come from `AutocompleteSuggestionService`. Both handlers are no-ops without
 * an open graph.
 */
export function useEditorAutocomplete(): EditorAutocomplete {
  const graph = useGraphInfo()
  const { autocompleteSuggestions } = useAppServices()

  const onWikilinkSearch = useCallback(
    (query: string): Promise<WikilinkItem[]> => autocompleteSuggestions.suggestLinks(query),
    [autocompleteSuggestions],
  )

  const onTagSearch = useCallback(
    async (query: string): Promise<TagItem[]> => {
      if (graph === null) {
        return []
      }
      return await autocompleteSuggestions.suggestTags(query)
    },
    [graph, autocompleteSuggestions],
  )

  return { onWikilinkSearch, onTagSearch }
}
