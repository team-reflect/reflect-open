import { useEffect } from 'react'
import { getIsComposing } from '@meowdown/core'
import type { AppCommandId } from '@reflect/app'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

const HISTORY_COMMAND_IDS = new Set<AppCommandId>(['history.back', 'history.forward'])

// AppKit owns these key equivalents on macOS. Keep them in the registry for
// display, collision detection, and the plain-browser/non-macOS fallback, but
// do not consume their keydown in the webview before the native menu sees it.
const NATIVE_MACOS_MENU_COMMAND_IDS = new Set<AppCommandId>([
  'sidebar.toggle',
  'note.find',
  'note.findNext',
  'note.findPrevious',
])

/**
 * Run the command that each keydown types, for every command that has a
 * handler in this window. Mount once per window.
 */
export function useCommandKeys(): void {
  const { platform } = useCoreServices()
  const { commands, nativeMenu } = useAppServices()

  useEffect(() => {
    // Runs the command of `event`, in the phase that `history` names.
    function run(event: KeyboardEvent, history: boolean): void {
      if (getIsComposing()) {
        return
      }
      const id = commands.commandForKeyDown(event)
      if (id === null || HISTORY_COMMAND_IDS.has(id) !== history) {
        return
      }
      if (
        platform.isMacosDesktop &&
        nativeMenu.isInstalled() &&
        NATIVE_MACOS_MENU_COMMAND_IDS.has(id)
      ) {
        return
      }
      if (commands.trigger(id)) {
        // Also keeps the native menu's matching accelerator from firing the
        // same command again: the webview consumes the key equivalent.
        event.preventDefault()
      }
    }

    // History moves are app chrome: they win even when the focused editor
    // would otherwise consume the bracket chord while bubbling.
    function onKeyDownCapture(event: KeyboardEvent): void {
      run(event, true)
    }

    // The focused editor gets first refusal. meowdown's `Mod-k` consumes the
    // keydown (preventDefault) only when it turns a selection or the link at
    // the caret into a link; the palette must not also open. When the editor
    // has nothing to do it leaves the event alone and `Mod-k` falls through.
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.defaultPrevented) {
        run(event, false)
      }
    }

    const controller = new AbortController()
    window.addEventListener('keydown', onKeyDownCapture, {
      capture: true,
      signal: controller.signal,
    })
    window.addEventListener('keydown', onKeyDown, { signal: controller.signal })
    return () => controller.abort()
  }, [commands, nativeMenu, platform])
}
