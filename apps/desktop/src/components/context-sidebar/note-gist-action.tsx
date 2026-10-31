import { useCallback, useState, useTransition, type ReactElement } from 'react'
import { CloudOff, CloudUpload } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useNoteRowOverlay } from '@/hooks/note-row-overlay.ts'
import { useGithubConnected } from '@/hooks/use-github-connected.ts'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { publishGistAndCopyLink } from '@/lib/clipboard-actions.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

type GistKind = 'publish' | 'unpublish'

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
  const services = useCoreServices()
  const { gistPublish } = services
  const app = useAppServices()
  const connected = useGithubConnected()
  const row = useNoteRow(path)
  // `row` already reflects a just-published or just-unpublished URL (the
  // optimistic overlay flows through `useNoteRow`); the raw overlay tells us
  // that a publish is still catching up, which keeps the action in the
  // published state until the index agrees.
  const optimistic = useNoteRowOverlay(path)?.gistUrl != null
  // The gist service never rejects (failures surface through the operations
  // status line) and refuses overlapping actions on the same note, so the
  // transition only drives the busy label.
  const [isBusy, startGistTransition] = useTransition()
  const [busyKind, setBusyKind] = useState<GistKind>('publish')

  const runGist = useCallback(
    (kind: GistKind): void => {
      setBusyKind(kind)
      startGistTransition(async () => {
        if (kind === 'publish') {
          await publishGistAndCopyLink(services, app, path)
        } else {
          await gistPublish.unpublish(path)
        }
      })
    },
    [services, app, path, gistPublish],
  )

  const published = optimistic || (row?.gistUrl ?? null) !== null
  if (!connected || row?.isPrivate === true) {
    return null
  }

  const label = isBusy
    ? busyKind === 'unpublish'
      ? 'Unpublishing…'
      : 'Publishing…'
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
            onClick={() => runGist(published ? 'unpublish' : 'publish')}
            disabled={isBusy}
            className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start hover:bg-surface-hover disabled:opacity-50"
          >
            <span className="flex h-5 w-5 flex-none items-center justify-center text-text-muted group-hover:text-text">
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
