import { createContext, use, useMemo, useState, type ReactElement, type ReactNode } from 'react'

type AllSearch = readonly [query: string, setQuery: (query: string) => void]

const AllSearchContext = createContext<AllSearch | null>(null)

/**
 * Holds the All tab's search text above the screens and the deep-link
 * intake, so opening a note and coming back keeps it and a search link can
 * fill it.
 */
export function AllSearchProvider({ children }: { children: ReactNode }): ReactElement {
  const [query, setQuery] = useState('')
  const search = useMemo((): AllSearch => [query, setQuery], [query])
  return <AllSearchContext value={search}>{children}</AllSearchContext>
}

/**
 * The All tab's search text and its setter.
 */
export function useAllSearch(): AllSearch {
  const search = use(AllSearchContext)
  if (search === null) {
    throw new Error('useAllSearch must be used inside AllSearchProvider')
  }
  return search
}
