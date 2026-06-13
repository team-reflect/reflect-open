import { useState, type ReactElement } from 'react'
import { CloudUpload } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useGithubConnected } from '@/hooks/use-github-connected'
import { useNoteRow } from '@/hooks/use-note-row'
import { runGistPublish } from '@/lib/note-gist'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'

interface NoteGistActionProps {
  /** Graph-relative path of the note the action operates on. */
  path: string
  /** Keybinding hint, from the matching command definition. */
  keybinding?: string | null
}

/**
 * The last publish's result, held until the index reflects it — the same
 * bridge as `NoteToggleAction`: the label otherwise lags one watcher
 * round-trip behind the frontmatter write, and in that window the button
 * would still read "Publish to gist" after the gist already exists.
 */
interface PendingPublish {
  path: string
  url: string
}

/**
 * "Publish to gist" as a Note actions button. Rendered only when a GitHub
 * credential is stored and the note isn't private (the publish path enforces
 * the privacy block again on live content — this is just not offering it).
 * After the first publish the label flips to "Republish gist", and an
 * accent-tinted icon plus tooltip nudge when the body changed since
 * (`gist_stale` from the index). Failures surface through the operations
 * status line; success copies the gist link to the clipboard.
 */
export function NoteGistAction({ path, keybinding = null }: NoteGistActionProps): ReactElement | null {
  const { graph } = useGraph()
  const connected = useGithubConnected()
  const row = useNoteRow(path)
  const [isPublishing, setIsPublishing] = useState(false)
  const [pending, setPending] = useState<PendingPublish | null>(null)

  // Render-time state adjustment: drop the bridge once the index reports the
  // published url (or the action moved to another note). Deliberately url-only:
  // also waiting for `gistStale` to clear could hold the bridge forever — a
  // body edited right after publishing keeps recomputing stale, and a stuck
  // bridge would suppress the republish nudge until navigation. The cost is a
  // one-watcher-round-trip nudge flash after a same-url republish.
  if (pending !== null && (pending.path !== path || row?.gistUrl === pending.url)) {
    setPending(null)
  }
  const bridged = pending !== null && pending.path === path
  const published = bridged || (row?.gistUrl ?? null) !== null
  const stale = !bridged && (row?.gistStale ?? false)

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
      const url = await runGistPublish(path, generation)
      if (url !== null) {
        setPending({ path, url })
      }
    } finally {
      setIsPublishing(false)
    }
  }

  const label = isPublishing ? 'Publishing…' : published ? 'Republish gist' : 'Publish to gist'
  const tooltip = stale
    ? 'The note changed since it was last published'
    : 'Creates a secret GitHub gist and copies its link'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void onPublish()}
          disabled={isPublishing}
          className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start transition-colors duration-100 hover:bg-surface-hover disabled:opacity-50"
        >
          <span
            className={cn(
              'flex h-5 w-5 flex-none items-center justify-center transition-colors duration-100',
              stale ? 'text-accent' : 'text-text-muted group-hover:text-text',
            )}
          >
            <CloudUpload size={14} aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
          {keybinding !== null ? (
            <ShortcutKeys binding={keybinding} className="invisible group-hover:visible" />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
