import type { ReactElement } from 'react'
import { keybindingFor, newNoteRoute } from '@/lib/commands/app-commands'
import { formatBindingLabel } from '@/lib/keybindings'
import { useRouter } from '@/routing/router'

const NEW_NOTE_BINDING = keybindingFor('note.new')

/**
 * The All Notes header's primary action — the same fresh-note route as ⌘N
 * (created lazily on the first keystroke), with the binding taught inline.
 */
export function NewNoteButton(): ReactElement {
  const { navigate } = useRouter()
  return (
    <button
      type="button"
      onClick={() => navigate(newNoteRoute())}
      className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover"
    >
      New note
      {NEW_NOTE_BINDING !== null ? (
        <span aria-hidden className="rounded bg-white/20 px-1 py-px text-[11px] font-medium">
          {formatBindingLabel(NEW_NOTE_BINDING)}
        </span>
      ) : null}
    </button>
  )
}
