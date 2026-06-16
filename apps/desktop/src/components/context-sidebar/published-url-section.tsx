import { useEffect, useState, type MouseEvent, type ReactElement } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNoteRow } from '@/hooks/use-note-row'
import { runGistPublish } from '@/lib/note-gist'
import { startOperation } from '@/lib/operations'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'
import { SidebarSection } from './sidebar-section'

interface PublishedUrlSectionProps {
  /** Graph-relative path of the note whose published URL should be shown. */
  path: string
}

type CopyState = 'idle' | 'copied'

const COPY_RESET_MS = 1400

/**
 * Shows the public URL for a note that has already been published to a gist,
 * plus a compact copy affordance for sharing it again.
 */
export function PublishedUrlSection({ path }: PublishedUrlSectionProps): ReactElement | null {
  const { graph } = useGraph()
  const row = useNoteRow(path)
  const url = row?.gistUrl ?? null
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [isUpdating, setIsUpdating] = useState(false)

  // Reset the transient "copied" badge whenever the published URL changes.
  const [appliedUrl, setAppliedUrl] = useState(url)
  if (appliedUrl !== url) {
    setAppliedUrl(url)
    setCopyState('idle')
  }

  useEffect(() => {
    if (copyState !== 'copied') {
      return
    }
    const timeout = window.setTimeout(() => setCopyState('idle'), COPY_RESET_MS)
    return () => window.clearTimeout(timeout)
  }, [copyState])

  if (url === null) {
    return null
  }

  const copyUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      setCopyState('copied')
      startOperation('Published URL copied').done()
    } catch (cause) {
      startOperation('Copying the published URL').fail(errorMessage(cause))
    }
  }

  const openPublishedUrl = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void openUrl(url)
    }
  }

  const updateGist = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined) {
      return
    }
    setIsUpdating(true)
    try {
      await runGistPublish(path, generation)
    } finally {
      setIsUpdating(false)
    }
  }

  const Icon = copyState === 'copied' ? Check : Copy

  return (
    <SidebarSection storageKey="published-url" title="Published URL">
      <div className="flex items-center gap-1.5 px-3 py-1">
        <a
          href={url}
          onClick={openPublishedUrl}
          className="min-w-0 flex-1 truncate text-xs text-text hover:underline"
          title={url}
        >
          {url}
        </a>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Copy published URL"
              onClick={() => void copyUrl()}
              className="text-text-muted hover:text-text"
            >
              <Icon aria-hidden className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copyState === 'copied' ? 'Copied' : 'Copy published URL'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Update published gist"
              onClick={() => void updateGist()}
              disabled={isUpdating}
              className={cn('text-text-muted hover:text-text', row?.gistStale === true && 'text-accent')}
            >
              <RefreshCw aria-hidden className={cn('size-3.5', isUpdating && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {row?.gistStale === true ? 'Update gist with latest note' : 'Update published gist'}
          </TooltipContent>
        </Tooltip>
      </div>
    </SidebarSection>
  )
}
