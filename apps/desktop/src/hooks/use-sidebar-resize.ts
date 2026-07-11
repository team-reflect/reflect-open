import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  clampSidebarWidth,
  CONTEXT_SIDEBAR_WIDTH_RANGE,
  SIDEBAR_WIDTH_RANGE,
  type SidebarWidthRange,
} from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'

/** How far one arrow-key press moves the divider, in CSS pixels. */
const KEYBOARD_STEP_PX = 16

/** Which resizable AppShell panel a handle controls. */
export type ResizableSidebarPanel = 'workspace' | 'context'

interface PanelSpec {
  /** The window edge the panel hugs — decides which drag direction widens it. */
  readonly side: 'left' | 'right'
  readonly settingsKey: 'sidebarWidth' | 'contextSidebarWidth'
  /** The root CSS variable the AppShell's width class reads. */
  readonly cssVariable: string
  readonly range: SidebarWidthRange
}

const PANEL_SPECS: Record<ResizableSidebarPanel, PanelSpec> = {
  workspace: {
    side: 'left',
    settingsKey: 'sidebarWidth',
    cssVariable: '--sidebar-width',
    range: SIDEBAR_WIDTH_RANGE,
  },
  context: {
    side: 'right',
    settingsKey: 'contextSidebarWidth',
    cssVariable: '--context-sidebar-width',
    range: CONTEXT_SIDEBAR_WIDTH_RANGE,
  },
}

interface DragState {
  pointerId: number
  startX: number
  startWidth: number
}

/**
 * The width variables with a drag in flight. While a variable is listed,
 * `SidebarWidthEffect` must not re-assert the persisted width over it — the
 * async settings hydration can land mid-drag and would yank the rail out
 * from under the pointer. The drag's release writes the variable and commits
 * to settings itself, so a skipped re-assert is never left stale.
 */
export const activeSidebarWidthDrags = new Set<string>()

/**
 * While a drag is live the cursor must read `col-resize` everywhere (pointer
 * capture routes events to the handle but does not pin the cursor) and text
 * selection must not paint across the panes the pointer sweeps.
 */
function setDragChrome(active: boolean): void {
  const style = document.documentElement.style
  if (active) {
    style.setProperty('cursor', 'col-resize')
    style.setProperty('user-select', 'none')
    style.setProperty('-webkit-user-select', 'none')
  } else {
    style.removeProperty('cursor')
    style.removeProperty('user-select')
    style.removeProperty('-webkit-user-select')
  }
}

/** State and handlers driving a sidebar resize handle. */
export interface SidebarResize {
  /** The panel's current width — live during a drag, the persisted value otherwise. */
  width: number
  /** The clamp range, for the separator's `aria-value*` attributes. */
  range: SidebarWidthRange
  dragging: boolean
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
    onDoubleClick: () => void
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  }
}

/**
 * Drag-to-resize for one AppShell sidebar. While the pointer moves, the width
 * is written straight to the panel's CSS variable — no settings churn and no
 * app-wide re-renders at pointer rate; the clamped result commits to the
 * settings document once on release (or per keystroke for the keyboard path).
 * Double-click restores the fresh-install width, the macOS divider
 * convention. Arrow keys move the divider itself, following ARIA separator
 * semantics: ArrowRight widens the left panel but narrows the right one.
 */
export function useSidebarResize(panel: ResizableSidebarPanel): SidebarResize {
  const { side, settingsKey, cssVariable, range } = PANEL_SPECS[panel]
  const { settings, updateSettings } = useSettings()
  const settingsWidth = settings[settingsKey]
  const dragRef = useRef<DragState | null>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)

  // The persisted width, readable from the unmount cleanup below.
  const settingsWidthRef = useRef(settingsWidth)
  useEffect(() => {
    settingsWidthRef.current = settingsWidth
  }, [settingsWidth])

  const applyWidth = useCallback(
    (width: number): void => {
      document.documentElement.style.setProperty(cssVariable, `${width}px`)
    },
    [cssVariable],
  )

  const commitWidth = useCallback(
    (width: number): void => {
      if (settingsKey === 'sidebarWidth') {
        updateSettings({ sidebarWidth: width })
      } else {
        updateSettings({ contextSidebarWidth: width })
      }
    },
    [settingsKey, updateSettings],
  )

  const widthAt = useCallback(
    (drag: DragState, clientX: number): number => {
      const travel = clientX - drag.startX
      const delta = side === 'left' ? travel : -travel
      return clampSidebarWidth(range, drag.startWidth + delta)
    },
    [range, side],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (event.button !== 0 || dragRef.current !== null) {
        return
      }
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId)
      } catch {
        // Synthetic tests do not have a live pointer to capture.
      }
      // Rebase on the aside's rendered width, not the persisted one: the
      // shell's viewport cap (`max-w-[40vw]`) can render the rail narrower
      // than the setting, and seeding from the setting would leave the
      // divider lagging the pointer by the difference. Layoutless test
      // environments measure zero and fall back to the setting.
      const rendered = event.currentTarget.parentElement?.getBoundingClientRect().width
      const startWidth = rendered ? clampSidebarWidth(range, rendered) : settingsWidth
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth,
      }
      activeSidebarWidthDrags.add(cssVariable)
      setDragWidth(startWidth)
      setDragChrome(true)
    },
    [range, settingsWidth, cssVariable],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) {
        return
      }
      const next = widthAt(drag, event.clientX)
      applyWidth(next)
      setDragWidth(next)
    },
    [widthAt, applyWidth],
  )

  const release = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) {
        return
      }
      dragRef.current = null
      activeSidebarWidthDrags.delete(cssVariable)
      setDragChrome(false)
      const next = widthAt(drag, event.clientX)
      applyWidth(next)
      commitWidth(next)
      setDragWidth(null)
    },
    [widthAt, applyWidth, commitWidth, cssVariable],
  )

  const onDoubleClick = useCallback((): void => {
    applyWidth(range.fallback)
    commitWidth(range.fallback)
  }, [applyWidth, commitWidth, range])

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (dragRef.current !== null) {
        return
      }
      const grow = side === 'left' ? 1 : -1
      let next: number
      switch (event.key) {
        case 'ArrowRight':
          next = clampSidebarWidth(range, settingsWidth + KEYBOARD_STEP_PX * grow)
          break
        case 'ArrowLeft':
          next = clampSidebarWidth(range, settingsWidth - KEYBOARD_STEP_PX * grow)
          break
        case 'Home':
          next = side === 'left' ? range.min : range.max
          break
        case 'End':
          next = side === 'left' ? range.max : range.min
          break
        default:
          return
      }
      event.preventDefault()
      applyWidth(next)
      commitWidth(next)
    },
    [side, range, settingsWidth, applyWidth, commitWidth],
  )

  // A drag interrupted by unmount (sidebar collapsed mid-drag, context route
  // left) never commits, so it must not leave anything behind: the app-wide
  // cursor and selection overrides come off, and the CSS variable reverts to
  // the persisted width — otherwise the rail would reopen at the abandoned
  // in-drag value until the next settings change.
  useEffect(() => {
    return () => {
      if (dragRef.current !== null) {
        activeSidebarWidthDrags.delete(cssVariable)
        setDragChrome(false)
        applyWidth(settingsWidthRef.current)
      }
    }
  }, [applyWidth, cssVariable])

  return {
    width: dragWidth ?? settingsWidth,
    range,
    dragging: dragWidth !== null,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: release,
      onPointerCancel: release,
      onDoubleClick,
      onKeyDown,
    },
  }
}
