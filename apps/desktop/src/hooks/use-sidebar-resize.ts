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

/**
 * Pointer travel before a press counts as a drag. Below this it is a click
 * and commits nothing — a bare click on the divider must never mutate the
 * saved preference.
 */
const DRAG_ACTIVATE_PX = 3

/** The center note pane never gives up more than this to the rails. */
export const EDITOR_MIN_WIDTH_PX = 360

/** Tailwind's `lg` breakpoint — the context aside is CSS-hidden below it. */
const CONTEXT_BREAKPOINT_PX = 1024

/** Which resizable AppShell panel a handle controls. */
export type ResizableSidebarPanel = 'workspace' | 'context'

/** DOM ids of the AppShell asides, for the separators' `aria-controls`. */
export const SIDEBAR_PANEL_IDS: Record<ResizableSidebarPanel, string> = {
  workspace: 'workspace-sidebar',
  context: 'context-sidebar',
}

interface PanelSpec {
  /** The window edge the panel hugs — decides which drag direction widens it. */
  readonly side: 'left' | 'right'
  readonly settingsKey: 'sidebarWidth' | 'contextSidebarWidth'
  /** The root CSS variable the AppShell's width class reads. */
  readonly cssVariable: string
  readonly range: SidebarWidthRange
  /** The other rail's landmark label, measured when computing drag room. */
  readonly otherAsideLabel: string
}

const PANEL_SPECS: Record<ResizableSidebarPanel, PanelSpec> = {
  workspace: {
    side: 'left',
    settingsKey: 'sidebarWidth',
    cssVariable: '--sidebar-width',
    range: SIDEBAR_WIDTH_RANGE,
    otherAsideLabel: 'Context',
  },
  context: {
    side: 'right',
    settingsKey: 'contextSidebarWidth',
    cssVariable: '--context-sidebar-width',
    range: CONTEXT_SIDEBAR_WIDTH_RANGE,
    otherAsideLabel: 'Workspace',
  },
}

/** What each rail actually renders at a given viewport width. */
export interface EffectiveSidebarWidths {
  workspace: number
  context: number
}

/**
 * The single source of truth for rendered rail widths. Preferences persist
 * at full size in settings; this derives what the current viewport can
 * honor, reserving {@link EDITOR_MIN_WIDTH_PX} for the note pane and scaling
 * both rails down proportionally when they cannot both fit. A rail never
 * shrinks below its range minimum — on a truly tiny window the editor gives
 * way instead, because unusable rails help no one. The context rail only
 * counts against the budget at viewports where CSS actually shows it.
 */
export function effectiveSidebarWidths(
  viewportWidth: number,
  preferredWorkspace: number,
  preferredContext: number,
): EffectiveSidebarWidths {
  const workspace = clampSidebarWidth(SIDEBAR_WIDTH_RANGE, preferredWorkspace)
  const context = clampSidebarWidth(CONTEXT_SIDEBAR_WIDTH_RANGE, preferredContext)
  const contextVisible = viewportWidth >= CONTEXT_BREAKPOINT_PX
  const budget = Math.max(0, viewportWidth - EDITOR_MIN_WIDTH_PX)
  const total = workspace + (contextVisible ? context : 0)
  if (total <= budget) {
    return { workspace, context }
  }
  const scale = budget / total
  return {
    workspace: Math.max(SIDEBAR_WIDTH_RANGE.min, Math.floor(workspace * scale)),
    context: contextVisible
      ? Math.max(CONTEXT_SIDEBAR_WIDTH_RANGE.min, Math.floor(context * scale))
      : context,
  }
}

interface DragState {
  pointerId: number
  startX: number
  startWidth: number
  /** The widest this drag may go: the range max, minus what the viewport lacks. */
  cap: number
  /** Set once travel passes {@link DRAG_ACTIVATE_PX}; a never-activated press is a click. */
  activated: boolean
}

/**
 * The width variables with an *activated* drag in flight. While a variable is
 * listed, `SidebarWidthEffect` must not re-assert the persisted width over it
 * — the async settings hydration can land mid-drag and would yank the rail
 * out from under the pointer. Registration waits for drag activation so a
 * bare press never suppresses a hydration it will not overwrite. The drag's
 * release writes the variable and commits to settings itself, so a skipped
 * re-assert is never left stale.
 */
export const activeSidebarWidthDrags = new Set<string>()

/**
 * While a drag is live the cursor must read `col-resize` everywhere (pointer
 * capture routes events to the handle but does not pin the cursor) and text
 * selection must not paint across the panes the pointer sweeps. The chrome is
 * shared across handles: it follows {@link activeSidebarWidthDrags}, so
 * ending one rail's drag while a second pointer still holds the other rail
 * keeps it in place.
 */
function syncDragChrome(): void {
  const style = document.documentElement.style
  if (activeSidebarWidthDrags.size > 0) {
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
  /** The rail's rendered width — live during a drag, viewport-effective otherwise. */
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
 * settings document once on release (or per keystroke for the keyboard path),
 * and only when it actually changed. Drags and keystrokes rebase on the
 * rail's *rendered* width and clamp to the room the viewport actually has
 * (see {@link effectiveSidebarWidths}), so the divider always tracks the
 * pointer and an against-the-wall gesture is a no-op rather than a silent
 * rewrite of the saved preference. Double-click restores the fresh-install
 * width, the macOS divider convention. Arrow keys move the divider itself,
 * following ARIA separator semantics: ArrowRight widens the left panel but
 * narrows the right one; Home/End jump to the rail's minimum/maximum.
 */
export function useSidebarResize(panel: ResizableSidebarPanel): SidebarResize {
  const { side, settingsKey, cssVariable, range, otherAsideLabel } = PANEL_SPECS[panel]
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

  // The divider's true starting width: the aside's rendered width, not the
  // persisted one — the viewport can render the rail narrower than the
  // setting, and stepping from the setting would leave the divider lagging
  // the pointer (or a keystroke) by the difference. Layoutless test
  // environments measure zero and fall back to the setting.
  const renderedBaseWidth = useCallback(
    (handle: HTMLElement): number => {
      const rendered = handle.parentElement?.getBoundingClientRect().width
      return rendered ? clampSidebarWidth(range, rendered) : settingsWidth
    },
    [range, settingsWidth],
  )

  // The widest a gesture may make this rail right now: its range max, capped
  // by the viewport minus the note pane's reserve and the other rail's
  // rendered width (zero when that rail is hidden or absent).
  const gestureCap = useCallback(
    (handle: HTMLElement): number => {
      const shell = handle.parentElement?.parentElement
      const other = shell?.querySelector(`aside[aria-label="${otherAsideLabel}"]`)
      const otherWidth = other?.getBoundingClientRect().width ?? 0
      const available = Math.floor(window.innerWidth - EDITOR_MIN_WIDTH_PX - otherWidth)
      return Math.min(range.max, Math.max(range.min, available))
    },
    [otherAsideLabel, range],
  )

  const widthAt = useCallback(
    (drag: DragState, clientX: number): number => {
      const travel = clientX - drag.startX
      const delta = side === 'left' ? travel : -travel
      return Math.min(drag.cap, clampSidebarWidth(range, drag.startWidth + delta))
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
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: renderedBaseWidth(event.currentTarget),
        cap: gestureCap(event.currentTarget),
        activated: false,
      }
    },
    [renderedBaseWidth, gestureCap],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) {
        return
      }
      if (!drag.activated) {
        if (Math.abs(event.clientX - drag.startX) < DRAG_ACTIVATE_PX) {
          return
        }
        drag.activated = true
        activeSidebarWidthDrags.add(cssVariable)
        syncDragChrome()
      }
      const next = widthAt(drag, event.clientX)
      applyWidth(next)
      setDragWidth(next)
    },
    [widthAt, applyWidth, cssVariable],
  )

  const release = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) {
        return
      }
      dragRef.current = null
      // A never-activated press is a click, not a drag — it registered no
      // suppression and commits nothing. An activated drag that returned to
      // its starting width also commits nothing: there is no change to save.
      if (drag.activated) {
        activeSidebarWidthDrags.delete(cssVariable)
        syncDragChrome()
        const next = widthAt(drag, event.clientX)
        applyWidth(next)
        if (next !== drag.startWidth) {
          commitWidth(next)
        }
        setDragWidth(null)
      }
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
      const base = renderedBaseWidth(event.currentTarget)
      const cap = gestureCap(event.currentTarget)
      const grow = side === 'left' ? 1 : -1
      let next: number
      switch (event.key) {
        case 'ArrowRight':
          next = clampSidebarWidth(range, base + KEYBOARD_STEP_PX * grow)
          break
        case 'ArrowLeft':
          next = clampSidebarWidth(range, base - KEYBOARD_STEP_PX * grow)
          break
        case 'Home':
          next = range.min
          break
        case 'End':
          next = range.max
          break
        default:
          return
      }
      event.preventDefault()
      next = Math.min(cap, next)
      // Pressing into a wall (the range or the viewport's room) is a no-op:
      // nothing moves, so nothing commits and the saved preference survives.
      if (next === base) {
        return
      }
      applyWidth(next)
      commitWidth(next)
    },
    [side, range, renderedBaseWidth, gestureCap, applyWidth, commitWidth],
  )

  // A drag interrupted by unmount (sidebar collapsed mid-drag, context route
  // left) never commits, so it must not leave anything behind: the app-wide
  // cursor and selection overrides come off, and the CSS variable reverts to
  // the persisted width — otherwise the rail would reopen at the abandoned
  // in-drag value until the next settings change.
  useEffect(() => {
    return () => {
      const drag = dragRef.current
      if (drag !== null && drag.activated) {
        activeSidebarWidthDrags.delete(cssVariable)
        syncDragChrome()
        applyWidth(settingsWidthRef.current)
      }
    }
  }, [applyWidth, cssVariable])

  const effective = effectiveSidebarWidths(
    window.innerWidth,
    settings.sidebarWidth,
    settings.contextSidebarWidth,
  )

  return {
    width: dragWidth ?? effective[panel],
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
