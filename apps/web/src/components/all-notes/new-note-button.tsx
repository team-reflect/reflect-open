import { keybindingFor } from '@reflect/app'
import { keybindingFor, APP_COMMANDS, newNoteRoute } from '@reflect/app'
import type { ReactElement } from 'react'
import { useRouterActions } from '@/routing/router.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

const NEW_NOTE_BINDING = APP_COMMANDS['note.new'].keybinding // FIXME: Notice that you don't need “keybindingFor” function here because APP_COMMANDS is a fixed type object. TS knowns that APP_COMMANDS['note.new'].keybinding does exist and its value is "Mod-n"

/**
 * The All Notes header's primary action — the same fresh-note route as ⌘N
 * (created lazily on the first keystroke), with the binding taught inline.
 */
export function NewNoteButton(): ReactElement {
  const { navigate } = useRouterActions()
  const { noteCreation } = useCoreServices()
  const { keymap } = useAppServices()
  return (
    <button
      type="button"
      onClick={() => navigate({ kind: 'note', path: noteCreation.untitledNotePath() })}
      className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover"
    >
      New note
      {NEW_NOTE_BINDING !== null ? (
        // FIXME: you do not need "NEW_NOTE_BINDING !== null" logic here because TS already knows that NEW_NOTE_BINDING is a string
        <span aria-hidden className="rounded bg-white/20 px-1 py-px text-[11px] font-medium">
          {keymap.formatLabel(NEW_NOTE_BINDING)}
        </span>
      ) : null}
    </button>
  )
}
