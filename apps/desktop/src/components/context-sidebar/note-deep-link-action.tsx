import { useState, type ReactElement } from 'react'
import { Link } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { runCopyDeepLink } from '@/lib/note-deep-link'
import { useGraph } from '@/providers/graph-provider'

interface NoteDeepLinkActionProps {
  /** Graph-relative path of the note the action operates on. */
  path: string
  /** Keybinding hint, from the matching command definition. */
  keybinding?: string | null
}

/**
 * "Copy deep link" as a Note actions button — the mouse-reachable counterpart
 * of the `note.copyDeepLink` command. Feedback (the "Deep link copied" status
 * line, failures) lives in {@link runCopyDeepLink}, shared with the command.
 */
export function NoteDeepLinkAction({
  path,
  keybinding = null,
}: NoteDeepLinkActionProps): ReactElement {
  const { graph } = useGraph()
  const [isCopying, setIsCopying] = useState(false)

  const onCopy = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined) {
      return
    }
    setIsCopying(true)
    try {
      await runCopyDeepLink(path, generation)
    } finally {
      setIsCopying(false)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void onCopy()}
          disabled={isCopying}
          className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start transition-colors duration-100 hover:bg-surface-hover disabled:opacity-50"
        >
          <span className="flex h-5 w-5 flex-none items-center justify-center text-text-muted transition-colors duration-100 group-hover:text-text">
            <Link size={14} aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">Copy deep link</span>
          {keybinding !== null ? (
            <ShortcutKeys binding={keybinding} className="invisible group-hover:visible" />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent>Copies a reflect:// link that opens this note</TooltipContent>
    </Tooltip>
  )
}
