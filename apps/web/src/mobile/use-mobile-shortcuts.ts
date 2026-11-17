import { useEffect } from 'react'
import { getIsComposing } from '@meowdown/core'
import { newNoteRoute } from '@/lib/commands/app-commands.ts'
import type { AppCommandId } from '@/lib/commands/types.ts'
import { quickOpenVisible } from '@/mobile/quick-open.tsx'
import { openChat } from '@/mobile/sidebar.ts'
import { useRouterActions } from '@/routing/router.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

const HISTORY_COMMAND_IDS = new Set<AppCommandId>(['history.back', 'history.forward'])

/**
 * Runs the app commands of a hardware keyboard on mobile (iOS and Android).
 * The keys come from the command registry, as on desktop; each command here
 * runs its mobile counterpart. A command without one does nothing.
 */
export function useMobileShortcuts(): void {
  const { commands } = useAppServices()
  const { noteCreation } = useCoreServices()
  const { navigate, selectSection, back, forward } = useRouterActions()

  useEffect(() => {
    const runners: Partial<Record<AppCommandId, () => void>> = {
      'nav.today': () => navigate({ kind: 'today' }, { focusEditor: true }),
      'nav.allNotes': () => selectSection('all'),
      'nav.tasks': () => selectSection('tasks'),
      'note.new': () => navigate(newNoteRoute(noteCreation)),
      'chat.open': () => openChat(navigate, selectSection),
      'palette.open': () => quickOpenVisible.set(true),
      'settings.open': () => navigate({ kind: 'settings', page: 'main' }),
      'history.back': back,
      'history.forward': forward,
    }

    // Runs the command of `event`, in the phase given by `history`.
    function run(event: KeyboardEvent, history: boolean): void {
      if (getIsComposing() || quickOpenVisible.get()) {
        return
      }
      const id = commands.commandForKeyDown(event)
      if (id === null || HISTORY_COMMAND_IDS.has(id) !== history) {
        return
      }
      const runner = runners[id]
      if (runner !== undefined) {
        event.preventDefault()
        runner()
      }
    }

    // History moves are app chrome: they win over the focused editor.
    function onKeyDownCapture(event: KeyboardEvent): void {
      run(event, true)
    }

    // The focused editor gets first refusal (`⌘K` on a selection makes a link).
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
  }, [commands, noteCreation, navigate, selectSection, back, forward])
}
