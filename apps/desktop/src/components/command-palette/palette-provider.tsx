import {
  createContext,
  useCallback,
  use,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

/**
 * Palette open/query state (Plan 08), provided once per workspace so both the
 * ⌘K command (via CommandContext.openPalette) and the `search/:query` route
 * can open the same surface.
 */

interface PaletteContextValue {
  open: boolean
  openPalette: (query?: string) => void
  closePalette: () => void
}

/**
 * The palette's input text, in its own context so readers of
 * {@link usePalette} do not re-render on every keystroke.
 */
interface PaletteQueryValue {
  query: string
  setQuery: (query: string) => void
}

const PaletteContext = createContext<PaletteContextValue | null>(null)
const PaletteQueryContext = createContext<PaletteQueryValue | null>(null)

export function PaletteProvider({ children }: { children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const openPalette = useCallback((initialQuery?: string) => {
    setQuery(initialQuery ?? '')
    setOpen(true)
  }, [])
  const closePalette = useCallback(() => {
    setOpen(false)
  }, [])

  const value = useMemo<PaletteContextValue>(
    () => ({ open, openPalette, closePalette }),
    [open, openPalette, closePalette],
  )
  const queryValue = useMemo<PaletteQueryValue>(() => ({ query, setQuery }), [query])
  return (
    <PaletteContext value={value}>
      <PaletteQueryContext value={queryValue}>{children}</PaletteQueryContext>
    </PaletteContext>
  )
}

export function usePalette(): PaletteContextValue {
  const context = use(PaletteContext)
  if (!context) {
    throw new Error('usePalette must be used within a PaletteProvider')
  }
  return context
}

export function usePaletteQuery(): PaletteQueryValue {
  const context = use(PaletteQueryContext)
  if (!context) {
    throw new Error('usePaletteQuery must be used within a PaletteProvider')
  }
  return context
}
