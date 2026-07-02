import { useEffect, useSyncExternalStore } from 'react'
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { z } from 'zod'

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
