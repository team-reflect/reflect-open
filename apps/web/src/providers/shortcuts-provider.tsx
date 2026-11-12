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
 * Open state for the ⌘/ shortcuts cheat-sheet (Plan 15), provided once per
 * workspace so the `shortcuts.show` command (via CommandContext) and the
 * dialog itself share one definition of "open" — the same shape as the
 * palette's provider.
 */

interface ShortcutsContextValue {
  open: boolean
  openShortcuts: () => void
  closeShortcuts: () => void
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null)

export function ShortcutsProvider({ children }: { children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false)

  const openShortcuts = useCallback(() => {
    setOpen(true)
  }, [])
  const closeShortcuts = useCallback(() => {
    setOpen(false)
  }, [])

  const value = useMemo<ShortcutsContextValue>(
    () => ({ open, openShortcuts, closeShortcuts }),
    [open, openShortcuts, closeShortcuts],
  )
  return <ShortcutsContext value={value}>{children}</ShortcutsContext>
}

export function useShortcuts(): ShortcutsContextValue {
  const context = use(ShortcutsContext)
  if (!context) {
    throw new Error('useShortcuts must be used within a ShortcutsProvider')
  }
  return context
}
