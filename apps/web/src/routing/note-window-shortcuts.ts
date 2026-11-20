import { useEffect } from 'react'
import { getIsComposing } from '@meowdown/core'
import { useRouterActions } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Runs `history.back` and `history.forward` against a note window's own
 * router: from the keyboard, and from the native menu commands routed to the
 * focused note window. The main window runs them through `useAppShortcuts`.
 */
export function useNoteWindowShortcuts(): void {
  const { commands, nativeMenu } = useAppServices()
  const { back, forward } = useRouterActions()

  useEffect(() => {
    // Runs the history command `commandId`. Returns whether it was one.
    function runHistory(commandId: string | null): boolean {
      if (commandId === 'history.back') {
        back()
        return true
      }
      if (commandId === 'history.forward') {
        forward()
        return true
      }
      return false
    }

    // Capture phase: history moves are app chrome and win over the focused
    // editor. Consuming the key also keeps the macOS menu, whose actions run
    // in the main window, from firing the same key equivalent.
    function onKeyDownCapture(event: KeyboardEvent): void {
      if (getIsComposing()) {
        return
      }
      if (runHistory(commands.commandForKeyDown(event))) {
        event.preventDefault()
      }
    }

    const controller = new AbortController()
    window.addEventListener('keydown', onKeyDownCapture, {
      capture: true,
      signal: controller.signal,
    })
    const unlistenMenu = nativeMenu.subscribeFocusedNoteCommands(runHistory)
    return () => {
      controller.abort()
      unlistenMenu()
    }
  }, [commands, nativeMenu, back, forward])
}
