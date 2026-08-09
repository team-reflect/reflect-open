import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  ANNOTATION_LIST_HEIGHT_RANGE,
  clampSidebarWidth,
  type SidebarWidthRange,
} from '@reflect/core'
import { getIsComposing } from '@meowdown/core'
import { useSettings } from '@/providers/settings-provider'
import {
  activeListHeightDrags,
  effectiveAnnotationListHeight,
  syncDragChrome,
} from './use-sidebar-resize'

/** How far one arrow-key press moves the divider, in CSS pixels. */
const KEYBOARD_STEP_PX = 16

/** Pointer travel before a press counts as a drag; a bare click commits nothing. */
const DRAG_ACTIVATE_PX = 3

/** The annotation list's height CSS variable, written straight to the root. */
const LIST_HEIGHT_VARIABLE = '--annotation-list-height'

interface DragState {
  pointerId: number
  startY: number
  startHeight: number
  /** The tallest this drag may go: the range max, minus what the window lacks. */
  cap: number
  /** Set once travel passes {@link DRAG_ACTIVATE_PX}; a never-activated press is a click. */
  activated: boolean
}

/** State and handlers driving the annotation list's height divider. */
export interface ListHeightResize {
  /** The list's rendered height — live during a drag, viewport-effective otherwise. */
  height: number
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
 * Drag-to-resize for the annotation list's height, the bottom-pane mirror of
 * {@link useSidebarResize}: the divider sits on the list's top edge, so
 * dragging up grows it and arrow keys follow the same value semantics
 * (ArrowUp grows the list, ArrowDown shrinks; Home/End jump to its
 * minimum/maximum). The height is written straight to the
 * `--annotation-list-height` variable at pointer rate and committed to the
 * settings document once on release (or per keystroke), and only when it
 * actually changed. Drags and keystrokes rebase on the list's *rendered*
 * height and clamp to the room the window actually has (see
 * {@link effectiveAnnotationListHeight}), so the divider always tracks the
 * pointer and an against-the-wall gesture is a no-op rather than a silent
 * rewrite of the saved preference. Double-click restores the fresh-install
 * height.
 */
export function useListHeightResize(): ListHeightResize {
  const { settings, updateSettings } = useSettings()
  const settingsHeight = settings.annotationListHeight
  const dragRef = useRef<DragState | null>(null)
  const [dragHeight, setDragHeight] = useState<number | null>(null)

  // The persisted height, readable from the unmount cleanup below.
  const settingsHeightRef = useRef(settingsHeight)
  useEffect(() => {
    settingsHeightRef.current = settingsHeight
  }, [settingsHeight])

  const applyHeight = useCallback((height: number): void => {
    document.documentElement.style.setProperty(LIST_HEIGHT_VARIABLE, `${height}px`)
  }, [])

  const commitHeight = useCallback(
    (height: number): void => {
      updateSettings({ annotationListHeight: height })
    },
    [updateSettings],
  )

  // The divider's true starting height: the list wrapper's rendered height
  // (the handle's parent carries the list's fixed height), falling back to
  // the setting in layoutless test environments.
  const renderedBaseHeight = useCallback(
    (handle: HTMLElement): number => {
      const rendered = handle.parentElement?.getBoundingClientRect().height
      return rendered ? clampSidebarWidth(ANNOTATION_LIST_HEIGHT_RANGE, rendered) : settingsHeight
    },
    [settingsHeight],
  )

  // The tallest this gesture may make the list: the effective height for the
  // maximum preference at the window's height — the range max, capped by the
  // window minus the PDF viewport's reserve. Same formula as the rendered
  // height, so drag room and display stay in step (the shell is h-screen, so
  // the window height is the panel's height).
  const gestureCap = useCallback((): number => {
    return Math.max(
      ANNOTATION_LIST_HEIGHT_RANGE.min,
      effectiveAnnotationListHeight(window.innerHeight, ANNOTATION_LIST_HEIGHT_RANGE.max),
    )
  }, [])

  const heightAt = useCallback((drag: DragState, clientY: number): number => {
    const travel = clientY - drag.startY
    // The divider is on the list's top edge: dragging up (negative travel)
    // grows the list.
    const delta = -travel
    return Math.min(
      drag.cap,
      clampSidebarWidth(ANNOTATION_LIST_HEIGHT_RANGE, drag.startHeight + delta),
    )
  }, [])

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
      const startHeight = renderedBaseHeight(event.currentTarget)
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight,
        // Never below the rendered height: the cap stops growth; it must not
        // shrink the current state on the first move.
        cap: Math.max(startHeight, gestureCap()),
        activated: false,
      }
    },
    [renderedBaseHeight, gestureCap],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) {
        return
      }
      if (!drag.activated) {
        if (Math.abs(event.clientY - drag.startY) < DRAG_ACTIVATE_PX) {
          return
        }
        drag.activated = true
        activeListHeightDrags.add(LIST_HEIGHT_VARIABLE)
        syncDragChrome()
      }
      const next = heightAt(drag, event.clientY)
      applyHeight(next)
      setDragHeight(next)
    },
    [heightAt, applyHeight],
  )

  const release = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) {
        return
      }
      dragRef.current = null
      // A never-activated press is a click, not a drag; an activated drag
      // that returned to its starting height also commits nothing.
      if (drag.activated) {
        activeListHeightDrags.delete(LIST_HEIGHT_VARIABLE)
        syncDragChrome()
        const next = heightAt(drag, event.clientY)
        applyHeight(next)
        if (next !== drag.startHeight) {
          commitHeight(next)
        }
        setDragHeight(null)
      }
    },
    [heightAt, applyHeight, commitHeight],
  )

  const onDoubleClick = useCallback((): void => {
    applyHeight(ANNOTATION_LIST_HEIGHT_RANGE.fallback)
    commitHeight(ANNOTATION_LIST_HEIGHT_RANGE.fallback)
  }, [applyHeight, commitHeight])

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (getIsComposing()) {
        return
      }
      if (dragRef.current !== null) {
        return
      }
      const base = renderedBaseHeight(event.currentTarget)
      const cap = Math.max(base, gestureCap())
      let next: number
      switch (event.key) {
        case 'ArrowUp':
          next = clampSidebarWidth(ANNOTATION_LIST_HEIGHT_RANGE, base + KEYBOARD_STEP_PX)
          break
        case 'ArrowDown':
          next = clampSidebarWidth(ANNOTATION_LIST_HEIGHT_RANGE, base - KEYBOARD_STEP_PX)
          break
        case 'Home':
          next = ANNOTATION_LIST_HEIGHT_RANGE.min
          break
        case 'End':
          next = ANNOTATION_LIST_HEIGHT_RANGE.max
          break
        default:
          return
      }
      event.preventDefault()
      next = Math.min(cap, next)
      // Pressing into a wall (the range or the window's room) is a no-op.
      if (next === base) {
        return
      }
      applyHeight(next)
      commitHeight(next)
    },
    [renderedBaseHeight, gestureCap, applyHeight, commitHeight],
  )

  // A drag interrupted by unmount (panel closed mid-drag) never commits, so it
  // must not leave anything behind: the chrome comes off and the variable
  // reverts to the persisted height.
  useEffect(() => {
    return () => {
      const drag = dragRef.current
      if (drag !== null && drag.activated) {
        activeListHeightDrags.delete(LIST_HEIGHT_VARIABLE)
        syncDragChrome()
        applyHeight(settingsHeightRef.current)
      }
    }
  }, [applyHeight])

  // The separator's reported value must track window scaling, so the hook
  // re-renders on window resize like `SidebarWidthEffect` does.
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = (): void => {
      setViewportHeight(window.innerHeight)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const effective = effectiveAnnotationListHeight(viewportHeight, settingsHeight)

  return {
    height: dragHeight ?? effective,
    range: ANNOTATION_LIST_HEIGHT_RANGE,
    dragging: dragHeight !== null,
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
