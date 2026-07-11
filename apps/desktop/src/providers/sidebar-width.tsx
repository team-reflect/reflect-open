import { useEffect, useState, type ReactElement } from 'react'
import { activeSidebarWidthDrags, effectiveSidebarWidths } from '@/hooks/use-sidebar-resize'
import { useSettings } from '@/providers/settings-provider'

/**
 * Applies the sidebar widths to the document root.
 *
 * Settings hold the *preferred* widths; what actually renders is
 * {@link effectiveSidebarWidths} of the current viewport — preferences are
 * honored when the window has room and scale back (never below their range
 * minimums) when it doesn't, restoring in full when it widens again. The
 * result lands on the `--sidebar-width` / `--context-sidebar-width` variables
 * the AppShell's aside widths read; the design-system tokens keep the
 * fresh-install defaults, so removing the overrides on unmount falls back
 * cleanly.
 *
 * During a drag the resize handle writes the same variables directly
 * (per-frame, without settings churn) and lists them in
 * {@link activeSidebarWidthDrags}; a variable with a drag in flight is
 * skipped here, so a settings hydration landing mid-drag cannot yank the
 * rail from under the pointer. The drag's release re-writes the variable and
 * commits, and this effect re-asserts that committed value.
 */
export function SidebarWidthEffect(): ReactElement | null {
  const { settings } = useSettings()
  const sidebarWidth = settings.sidebarWidth
  const contextSidebarWidth = settings.contextSidebarWidth
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)

  useEffect(() => {
    const onResize = (): void => {
      setViewportWidth(window.innerWidth)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    const { workspace, context } = effectiveSidebarWidths(
      viewportWidth,
      sidebarWidth,
      contextSidebarWidth,
    )
    const style = document.documentElement.style
    if (!activeSidebarWidthDrags.has('--sidebar-width')) {
      style.setProperty('--sidebar-width', `${workspace}px`)
    }
    if (!activeSidebarWidthDrags.has('--context-sidebar-width')) {
      style.setProperty('--context-sidebar-width', `${context}px`)
    }
  }, [viewportWidth, sidebarWidth, contextSidebarWidth])

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
