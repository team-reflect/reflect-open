import { useEffect } from 'react'
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { z } from 'zod'

const keyboardStateSchema = z.object({ height: z.number(), duration: z.number() })

let currentKeyboardHeight = 0

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
  currentKeyboardHeight = height
}

/**
 * Mirrors the software keyboard's overlap height into `--keyboard-height` on
 * the document root (Plan 19, decision 8). The Swift half of
 * `tauri-plugin-keyboard` keeps the webview at its full-screen frame and
 * disables the system's scroll nudging, so layout owns keyboard avoidance:
 * containers pad their bottom by the variable to keep content reachable. The
 * height is also published to {@link getKeyboardHeight} for non-layout
 * consumers (the day carousel disables swiping while the keyboard is up).
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
