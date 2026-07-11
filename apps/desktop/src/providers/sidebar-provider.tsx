import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

/**
 * Side-panel visibility state, provided once per workspace so the shell
 * (which renders or hides both sidebar regions) and the command registry
 * (`⌘\` / "Toggle sidebar") share one source of truth. Session-only by
 * design — a relaunch starts expanded.
 */

interface SidebarContextValue {
  collapsed: boolean
  toggleSidebar: () => void
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

export function SidebarProvider({ children }: { children: ReactNode }): ReactElement {
  const [collapsed, setCollapsed] = useState(false)
  const toggleSidebar = useCallback(() => {
    setCollapsed((current) => !current)
  }, [])

  const value = useMemo<SidebarContextValue>(
    () => ({ collapsed, toggleSidebar }),
    [collapsed, toggleSidebar],
  )
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
}

/** Access side-panel visibility + the toggle. Use within a SidebarProvider. */
export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider')
  }
  return context
}
