import { useEffect, useSyncExternalStore } from 'react'
import { focusedEditorCommands } from '@/editor/formatting-toolbar-store'

let currentKeyboardHeight = 0
const keyboardListeners = new Set<() => void>()

/**
 * The last published keyboard overlap in px — `0` when the keyboard is closed.
 * A plain getter (not a hook) so imperative call sites — Embla's `watchDrag`
 * predicate fires at drag start, outside React — can read the live value.
 */
export function getKeyboardHeight(): number {
  return currentKeyboardHeight
}

/**
 * Record the keyboard overlap height. Called by {@link useKeyboardHeightVar}
 * as the visual viewport changes; exported so tests can drive keyboard state
 * without a real keyboard.
 */
export function publishKeyboardHeight(height: number): void {
  if (height === currentKeyboardHeight) {
    return
  }
  currentKeyboardHeight = height
  for (const listener of keyboardListeners) {
    listener()
  }
}

function subscribeKeyboard(listener: () => void): () => void {
  keyboardListeners.add(listener)
  return () => {
    keyboardListeners.delete(listener)
  }
}

function keyboardVisibleSnapshot(): boolean {
  return currentKeyboardHeight > 0
}

/**
 * Whether the software keyboard is up, as reactive state. The tab bar hides
 * on it — with the shell root sized to end at the keyboard's top (decision 8),
 * the bar would otherwise ride up above the keyboard, and V1 lets the
 * keyboard cover it instead.
 */
export function useKeyboardVisible(): boolean {
  return useSyncExternalStore(subscribeKeyboard, keyboardVisibleSnapshot, keyboardVisibleSnapshot)
}

/**
 * The smallest visual-viewport shrink treated as the software keyboard;
 * anything under it is browser-chrome noise. Same threshold as Base UI:
 * https://github.com/mui/base-ui/blob/v1.7.0/packages/react/src/drawer/virtual-keyboard-provider/DrawerVirtualKeyboardProvider.tsx#L25
 */
const KEYBOARD_MIN_OVERLAP = 60

/** How long after a blur a lingering overlap is treated as stale (iOS 26.0). */
const KEYBOARD_STALE_DELAY_MS = 1500

/**
 * The keyboard overlap per `visualViewport`. `KeyboardPlugin.swift` pins the
 * webview (frame and scroll offset), so the layout viewport always matches
 * the screen and the visual-viewport shortfall is exactly the keyboard
 * overlap (decision 0003).
 */
function readKeyboardOverlap(): number {
  const viewport = window.visualViewport
  if (!viewport || viewport.scale !== 1) {
    return 0
  }
  const overlap = window.innerHeight - viewport.height - viewport.offsetTop
  return overlap > KEYBOARD_MIN_OVERLAP ? Math.round(overlap) : 0
}

/**
 * Mirrors the software keyboard's overlap height into `--keyboard-height` on
 * the document root (Plan 19, decision 8). With the webview pinned by the
 * Swift half of `tauri-plugin-keyboard`, `visualViewport` is the honest
 * keyboard signal and no native event bridge is needed. The mobile shell root
 * sizes itself to `calc(100dvh - var(--keyboard-height))`; only
 * viewport-anchored (`position: fixed`) elements read the variable directly.
 * The height is also published to {@link getKeyboardHeight} /
 * {@link useKeyboardVisible} for non-layout consumers (the carousel's swipe
 * guard, the tab bar hiding).
 */
export function useKeyboardHeightVar(): void {
  // Viewport reader: feeds the store, which drops no-op publishes.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) {
      return undefined
    }
    const apply = (): void => {
      publishKeyboardHeight(readKeyboardOverlap())
    }
    // iOS 26.0 leaves the visual viewport stale after the keyboard closes
    // (https://developer.apple.com/forums/thread/800125, fixed in 26.1). If
    // focus has left every editable element and an overlap still reads,
    // clear it; on healthy systems the overlap is already 0 by then and the
    // timer is a no-op.
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const onFocusOut = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        const el = document.activeElement
        const editing =
          el instanceof HTMLElement && (el.isContentEditable || el.matches('textarea, input'))
        if (!editing && readKeyboardOverlap() > 0) {
          publishKeyboardHeight(0)
        }
      }, KEYBOARD_STALE_DELAY_MS)
    }
    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      document.removeEventListener('focusout', onFocusOut)
      clearTimeout(watchdog)
      publishKeyboardHeight(0)
    }
  }, [])

  // Store subscriber: touches the CSS variable only when the value changed.
  const height = useSyncExternalStore(subscribeKeyboard, getKeyboardHeight, getKeyboardHeight)
  useEffect(() => {
    document.documentElement.style.setProperty('--keyboard-height', `${height}px`)
    return () => {
      document.documentElement.style.removeProperty('--keyboard-height')
    }
  }, [height])
}

/**
 * Input types that raise the software keyboard; `input.type` normalizes a
 * missing attribute to `'text'`. Same allowlist as Base UI:
 * https://github.com/mui/base-ui/blob/v1.7.0/packages/react/src/drawer/virtual-keyboard-provider/DrawerVirtualKeyboardProvider.tsx#L42
 */
const KEYBOARD_INPUT_TYPES = new Set(['email', 'number', 'password', 'search', 'tel', 'text', 'url'])

function focusedKeyboardField(): HTMLElement | null {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement) {
    return el
  }
  if (el instanceof HTMLInputElement && KEYBOARD_INPUT_TYPES.has(el.type)) {
    return el
  }
  // contenteditable (the editor) is useKeyboardCaretReveal's job; everything
  // else does not raise the keyboard.
  return null
}

/**
 * Scrolls the focused form field above the keyboard, whenever the keyboard
 * height changes or focus moves. Relies on the container's `.keyboard-slack`
 * (scroll room + `scroll-padding-bottom`); the native scroll pin already
 * blocks WebKit's own reveal, so one plain `scrollIntoView` is enough.
 */
export function useKeyboardFieldReveal(): void {
  const height = useSyncExternalStore(subscribeKeyboard, getKeyboardHeight, getKeyboardHeight)

  useEffect(() => {
    if (height <= 0) {
      return undefined
    }
    const reveal = (): void => {
      focusedKeyboardField()?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    // One frame late, so the slack padding is laid out before we measure.
    const frame = requestAnimationFrame(reveal)
    document.addEventListener('focusin', reveal)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('focusin', reveal)
    }
  }, [height])
}

/**
 * Re-reveals the caret whenever the keyboard changes the visible area.
 *
 * Focus raises the keyboard before any height arrives, so the focus-time
 * reveal ran against the full-height viewport and did nothing; once the shell
 * shrinks, nothing else scrolls the caret back (WebKit's own reveal is pinned
 * off in `KeyboardPlugin.swift`). Mounted once: every screen's editors publish
 * to the same focused-editor slot, and `scrollCaretIntoView` is a no-op while
 * the caret is already visible.
 */
export function useKeyboardCaretReveal(): void {
  const height = useSyncExternalStore(subscribeKeyboard, getKeyboardHeight, getKeyboardHeight)

  useEffect(() => {
    if (height <= 0) {
      return
    }
    // Passive effect: runs after the paint that applied the shrunken shell,
    // so the scroll container is already at its final height.
    focusedEditorCommands()?.scrollCaretIntoView()
    // Backstop for chrome that settles a frame late (the tab bar swaps for
    // the toolbar); re-read the slot, the focused editor may have changed.
    const frame = requestAnimationFrame(() => {
      focusedEditorCommands()?.scrollCaretIntoView()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [height])
}
