import { useEffect, useState, type ReactElement } from 'react'
import { errorMessage, type ArchivedVersion } from '@reflect/core'
import { History } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { formatFullDate, formatTimeOfDay } from '@/lib/dates.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

interface NoteVersionsActionProps {
  /** Graph-relative path of the note whose earlier versions to show. */
  path: string
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * Lists the earlier versions that sync set aside for a note, shows one
 * read-only, and restores it over the note. Renders nothing while the note
 * has no earlier versions, which it checks when it mounts and again each time the dialog opens.
 */
export function NoteVersionsAction({ path }: NoteVersionsActionProps): ReactElement | null {
  const { conflictArchive } = useCoreServices()
  const { operations } = useAppServices()
  const { settings } = useSettings()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<{ path: string; list: ArchivedVersion[] } | null>(null)
  const versions = loaded?.path === path ? loaded.list : null
  const [selected, setSelected] = useState<{ name: string; content: string } | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      setLoaded({ path, list: await conflictArchive.list(path) })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  useEffect(() => {
    let current = true
    conflictArchive
      .list(path)
      .then((list) => {
        if (current) {
          setLoaded({ path, list })
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(errorMessage(cause))
        }
      })
    return () => {
      current = false
    }
  }, [path, conflictArchive])

  const onOpen = (): void => {
    setOpen(true)
    setError(null)
    setSelected(null)
    void reload()
  }

  const onSelect = async (name: string): Promise<void> => {
    setError(null)
    try {
      setSelected({ name, content: await conflictArchive.read(path, name) })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const onRestore = async (): Promise<void> => {
    if (selected === null) {
      return
    }
    const operation = operations.start('Restoring version')
    setIsRestoring(true)
    setError(null)
    try {
      await conflictArchive.restore(path, selected.name)
      operation.done()
      setOpen(false)
    } catch (cause) {
      const message = errorMessage(cause)
      setError(message)
      operation.fail(message)
    } finally {
      setIsRestoring(false)
    }
  }

  if (versions === null || (versions.length === 0 && !open)) {
    return null
  }

  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start hover:bg-surface-hover"
      >
        <span className="flex h-5 w-5 flex-none items-center justify-center text-text-muted">
          <History size={14} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">Earlier versions</span>
      </button>

      <Dialog open={open} onOpenChange={(next) => !isRestoring && setOpen(next)}>
        <DialogContent>
          <DialogTitle>Earlier versions</DialogTitle>
          <DialogDescription>
            Sync set these versions aside when it merged overlapping edits.
          </DialogDescription>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {versions.map((version) => {
              const date = new Date(version.modifiedMs)
              return (
                <li key={version.name}>
                  <button
                    type="button"
                    aria-pressed={selected?.name === version.name}
                    onClick={() => void onSelect(version.name)}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-start text-xs hover:bg-surface-hover aria-pressed:bg-surface-hover"
                  >
                    <span>
                      {formatFullDate(date, settings.dateFormat)}{' '}
                      {formatTimeOfDay(date, settings.timeFormat)}
                    </span>
                    <span className="text-text-muted">
                      {version.device}, {formatSize(version.size)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {selected !== null ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-hover p-3 text-xs">
              {selected.content}
            </pre>
          ) : null}
          {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="ghost" disabled={isRestoring}>
                  Close
                </Button>
              }
            />
            <Button disabled={isRestoring || selected === null} onClick={() => void onRestore()}>
              Restore this version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
