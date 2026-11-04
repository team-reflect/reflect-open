import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type MouseEvent,
  type ReactElement,
} from 'react'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { publishGistAndCopyLink } from '@/lib/clipboard-actions.ts'
import { cn } from '@/lib/utils.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { SidebarSection } from './sidebar-section.tsx'

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
  const services = useCoreServices()
  const app = useAppServices()
  const { clipboard, opener, operations } = app
  const row = useNoteRow(path)
  const url = row?.gistUrl ?? null
  const [copyState, setCopyState] = useState<CopyState>('idle')
  // The gist service never rejects, so the transition only drives the spinner.
  const [isUpdating, startUpdate] = useTransition()

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

  const updateGist = useCallback((): void => {
    startUpdate(async () => {
      await publishGistAndCopyLink(services, app, path)
    })
  }, [services, app, path])

  if (url === null) {
    return null
  }

  const copyUrl = async (): Promise<void> => {
    try {
      await clipboard.writeText(url)
      setCopyState('copied')
      operations.start('Published URL copied').done()
    } catch (cause) {
      operations.start('Copying the published URL').fail(errorMessage(cause))
    }
  }

  const openPublishedUrl = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      opener.openUrlSync(url)
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
          <TooltipTrigger
            render={
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
            }
          />
          <TooltipContent>
            {copyState === 'copied' ? 'Copied' : 'Copy published URL'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Update published gist"
                onClick={updateGist}
                disabled={isUpdating}
                className={cn(
                  'text-text-muted hover:text-text',
                  row?.gistStale === true && 'text-accent',
                )}
              >
                <RefreshCw aria-hidden className={cn('size-3.5', isUpdating && 'animate-spin')} />
              </Button>
            }
          />
          <TooltipContent>
            {row?.gistStale === true ? 'Update gist with latest note' : 'Update published gist'}
          </TooltipContent>
        </Tooltip>
      </div>
    </SidebarSection>
  )
}
