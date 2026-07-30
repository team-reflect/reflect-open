import { useState, type ReactElement } from 'react'
import { CloudOff, CloudUpload } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNoteRowOverlay } from '@/hooks/note-row-overlay'
import { useGithubConnected } from '@/hooks/use-github-connected'
import { useNoteRow } from '@/hooks/use-note-row'
import { runGistPublish, runGistUnpublish } from '@/lib/note-gist'
import { useGraph } from '@/providers/graph-provider'

interface NoteGistActionProps {
  /** Graph-relative path of the note the action operates on. */
  path: string
  /** Keybinding hint, from the matching command definition. */
  keybinding?: string | null
}

/**
 * Private-link sharing as a Note actions button. Rendered only when a GitHub
 * credential is stored and the note isn't private (the publish path enforces
 * the privacy block again on live content — this is just not offering it).
 * After the first publish the label flips to "Unpublish link". The published
 * URL section owns the update action, including the stale-body nudge from the
 * index. Failures and success state surface through the operations status line.
 */
export function NoteGistAction({
  path,
  keybinding = null,
}: NoteGistActionProps): ReactElement | null {
  const { graph } = useGraph()
  const connected = useGithubConnected()
  const row = useNoteRow(path)
  // `row` already reflects a just-published or just-unpublished URL (the
  // optimistic overlay flows through `useNoteRow`); the raw overlay tells us
  // that a publish is still catching up, which keeps the action in the
  // published state until the index agrees.
  const optimistic = useNoteRowOverlay(path, graph?.generation)?.gistUrl != null
  const [isPublishing, setIsPublishing] = useState(false)
  const [isUnpublishing, setIsUnpublishing] = useState(false)

  const published = optimistic || (row?.gistUrl ?? null) !== null
  if (!connected || row?.isPrivate === true) {
    return null
  }

  const onPublish = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined) {
      return
    }
    setIsPublishing(true)
    try {
      await runGistPublish(path, generation)
    } finally {
      setIsPublishing(false)
    }
  }

  const onUnpublish = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined) {
      return
    }
    setIsUnpublishing(true)
    try {
      await runGistUnpublish(path, generation)
    } finally {
      setIsUnpublishing(false)
    }
  }

  const isBusy = isPublishing || isUnpublishing
  const label = isUnpublishing
    ? 'Unpublishing…'
    : isPublishing
      ? 'Publishing…'
      : published
        ? 'Unpublish link'
        : 'Share with private link'
  const tooltip = published
    ? 'Delete the private GitHub gist for this note'
    : 'Creates a secret GitHub gist and copies its private link'
  const Icon = published ? CloudOff : CloudUpload

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => void (published ? onUnpublish() : onPublish())}
            disabled={isBusy}
            className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start transition-colors duration-100 hover:bg-surface-hover disabled:opacity-50"
          >
            <span className="flex h-5 w-5 flex-none items-center justify-center text-text-muted transition-colors duration-100 group-hover:text-text">
              <Icon size={14} aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
            {keybinding !== null ? (
              <ShortcutKeys binding={keybinding} className="invisible group-hover:visible" />
            ) : null}
          </button>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
