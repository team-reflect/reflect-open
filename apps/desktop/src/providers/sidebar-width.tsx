import { useEffect, type ReactElement } from 'react'
import { activeSidebarWidthDrags } from '@/hooks/use-sidebar-resize'
import { useSettings } from '@/providers/settings-provider'

/**
 * Applies the persisted sidebar widths to the document root.
 *
 * Mirrors `sidebarWidth` and `contextSidebarWidth` onto the `--sidebar-width`
 * and `--context-sidebar-width` variables the AppShell's aside widths read.
 * The design-system tokens keep the fresh-install defaults, so removing the
 * overrides on unmount falls back cleanly. During a drag the resize handle
 * writes the same variables directly (per-frame, without settings churn) and
 * lists them in {@link activeSidebarWidthDrags}; a variable with a drag in
 * flight is skipped here, so a settings hydration landing mid-drag cannot
 * yank the rail from under the pointer. The drag's release re-writes the
 * variable and commits, and this effect re-asserts that committed value.
 */
export function SidebarWidthEffect(): ReactElement | null {
  const { settings } = useSettings()
  const sidebarWidth = settings.sidebarWidth
  const contextSidebarWidth = settings.contextSidebarWidth

  useEffect(() => {
    const style = document.documentElement.style
    if (!activeSidebarWidthDrags.has('--sidebar-width')) {
      style.setProperty('--sidebar-width', `${sidebarWidth}px`)
    }
    if (!activeSidebarWidthDrags.has('--context-sidebar-width')) {
      style.setProperty('--context-sidebar-width', `${contextSidebarWidth}px`)
    }
  }, [sidebarWidth, contextSidebarWidth])

  // Removal is unmount-only: a per-change cleanup would strip a variable the
  // guard above then declines to re-set, dropping a mid-drag rail back to the
  // token default.
  useEffect(() => {
    return () => {
      const style = document.documentElement.style
      style.removeProperty('--sidebar-width')
      style.removeProperty('--context-sidebar-width')
    }
  }, [])

  return null
}
