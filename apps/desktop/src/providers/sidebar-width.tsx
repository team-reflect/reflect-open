import { useEffect, useState, type ReactElement } from 'react'
import {
  activeListHeightDrags,
  activeSidebarWidthDrags,
  effectiveAnnotationListHeight,
  effectivePreviewPanelWidth,
  effectiveSidebarWidths,
} from '@/hooks/use-sidebar-resize'
import { useSettings } from '@/providers/settings-provider'

/**
 * Applies the sidebar widths and the annotation list's height to the document
 * root.
 *
 * Settings hold the *preferred* sizes; what actually renders is the effective
 * sizes of the current viewport — preferences are honored when the window has
 * room and scale back (never below their range minimums) when it doesn't,
 * restoring in full when it widens again. The result lands on the
 * `--sidebar-width` / `--context-sidebar-width` variables the AppShell's
 * aside widths read and the `--preview-panel-width` the resident preview pane
 * reads; the design-system tokens keep the fresh-install defaults, so removing
 * the overrides on unmount falls back cleanly. The annotation list's height
 * reads `--annotation-list-height` from
 * {@link effectiveAnnotationListHeight}, capped so the PDF viewport keeps its
 * reserve.
 *
 * During a drag the resize handle writes the same variables directly
 * (per-frame, without settings churn) and lists them in
 * {@link activeSidebarWidthDrags} / {@link activeListHeightDrags}; a variable
 * with a drag in flight is skipped here, so a settings hydration landing
 * mid-drag cannot yank the pane from under the pointer. The drag's release
 * re-writes the variable and commits, and this effect re-asserts that
 * committed value.
 */
export function SidebarWidthEffect(): ReactElement | null {
  const { settings } = useSettings()
  const sidebarWidth = settings.sidebarWidth
  const contextSidebarWidth = settings.contextSidebarWidth
  const previewPanelWidth = settings.previewPanelWidth
  const annotationListHeight = settings.annotationListHeight
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))

  useEffect(() => {
    const onResize = (): void => {
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    const { workspace, context } = effectiveSidebarWidths(
      viewport.width,
      sidebarWidth,
      contextSidebarWidth,
    )
    const preview = effectivePreviewPanelWidth(
      viewport.width,
      workspace,
      context,
      previewPanelWidth,
    )
    const listHeight = effectiveAnnotationListHeight(viewport.height, annotationListHeight)
    const style = document.documentElement.style
    if (!activeSidebarWidthDrags.has('--sidebar-width')) {
      style.setProperty('--sidebar-width', `${workspace}px`)
    }
    if (!activeSidebarWidthDrags.has('--context-sidebar-width')) {
      style.setProperty('--context-sidebar-width', `${context}px`)
    }
    if (!activeSidebarWidthDrags.has('--preview-panel-width')) {
      style.setProperty('--preview-panel-width', `${preview}px`)
    }
    if (!activeListHeightDrags.has('--annotation-list-height')) {
      style.setProperty('--annotation-list-height', `${listHeight}px`)
    }
  }, [viewport, sidebarWidth, contextSidebarWidth, previewPanelWidth, annotationListHeight])

  // Removal is unmount-only: a per-change cleanup would strip a variable the
  // guard above then declines to re-set, dropping a mid-drag pane back to the
  // token default.
  useEffect(() => {
    return () => {
      const style = document.documentElement.style
      style.removeProperty('--sidebar-width')
      style.removeProperty('--context-sidebar-width')
      style.removeProperty('--preview-panel-width')
      style.removeProperty('--annotation-list-height')
    }
  }, [])

  return null
}
