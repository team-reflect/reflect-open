import { useEffect, useSyncExternalStore } from 'react'
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import { focusedEditorCommands } from '@/editor/formatting-toolbar-store'

const keyboardStateSchema = z.object({ height: z.number(), duration: z.number() })

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
 * as the plugin's events arrive; exported so tests can drive keyboard state
 * without the Tauri bridge.
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

function keyboardHeightSnapshot(): number {
  return currentKeyboardHeight
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
 * Mirrors the software keyboard's overlap height into `--keyboard-height` on
 * the document root (Plan 19, decision 8). The Swift half of
 * `tauri-plugin-keyboard` keeps the webview at its full-screen frame and
 * disables the system's scroll nudging, so layout owns keyboard avoidance:
 * the mobile shell root sizes itself to `calc(100dvh - var(--keyboard-height))`,
 * ending the layout — and floating-ui's positioning boundary (`body`) — at
 * the keyboard's top. Only viewport-anchored (`position: fixed`) elements
 * still read the variable directly. The height is also published to
 * {@link getKeyboardHeight} / {@link useKeyboardVisible} for non-layout
 * consumers (the carousel's swipe guard, the tab bar hiding).
 */
export function useKeyboardHeightVar(): void {
  useEffect(() => {
    const root = document.documentElement
    const apply = (height: number): void => {
      root.style.setProperty('--keyboard-height', `${Math.round(height)}px`)
      publishKeyboardHeight(height)
    }
    let disposed = false
    let unlisten: (() => void) | null = null
    void (async () => {
      try {
        const initial = keyboardStateSchema.parse(await invoke('plugin:keyboard|current_height'))
        if (!disposed) {
          apply(initial.height)
        }
        const listener = await addPluginListener('keyboard', 'keyboardChange', (raw: unknown) => {
          const parsed = keyboardStateSchema.safeParse(raw)
          if (parsed.success) {
            apply(parsed.data.height)
          }
        })
        if (disposed) {
          void listener.unregister()
        } else {
          unlisten = () => {
            void listener.unregister()
          }
        }
      } catch (err) {
        // Fail loud in the log, soft in layout: without the bridge the
        // variable stays 0 and the screen behaves like Tauri's default.
        console.error('keyboard bridge unavailable:', err)
      }
    })()
    return () => {
      disposed = true
      unlisten?.()
      root.style.removeProperty('--keyboard-height')
      publishKeyboardHeight(0)
    }
  }, [])
}

/**
 * Re-reveals the caret whenever the keyboard changes the visible area.
 *
 * {@link useKeyboardHeightVar} shrinks the shell by the keyboard's height, but
 * that height only arrives as the keyboard starts animating up, long after the
 * focus that raised it. That focus ran against the full-height viewport, where
 * the caret was still visible, so neither WebKit's caret reveal (pinned off in
 * `KeyboardPlugin.swift`) nor ProseMirror's had anything to do; tapping a
 * paragraph at the bottom of a long note then left the caret under the
 * keyboard, with nothing to scroll it back.
 *
 * The keyboard is the only thing that occludes, so the keyboard is what
 * re-reveals. That makes this a single mount: every screen's editors publish to
 * the same focused-editor slot, and a height change under an already-raised
 * keyboard (a CJK candidate bar) is covered for free.
 *
 * `scrollCaretIntoView` is a no-op while the caret is visible, so raising the
 * keyboard with the caret near the top of a note scrolls nothing.
 */
export function useKeyboardCaretReveal(): void {
  const height = useSyncExternalStore(
    subscribeKeyboard,
    keyboardHeightSnapshot,
    keyboardHeightSnapshot,
  )

  useEffect(() => {
    if (height <= 0) {
      return
    }
    // A passive effect, so this runs after the paint that applied both the CSS
    // variable and the tab bar's swap for the formatting toolbar: the scroll
    // container is already at its final height. The one frame that painted the
    // caret still occluded is invisible inside the keyboard's own animation.
    focusedEditorCommands()?.scrollCaretIntoView()
    // Backstop for chrome that settles a frame late (the tab bar unmounting
    // republishes `--mobile-tab-bar-height`). Re-read the slot: by now the
    // editor may have unmounted, or another may hold the caret.
    const frame = requestAnimationFrame(() => {
      focusedEditorCommands()?.scrollCaretIntoView()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [height])
}
