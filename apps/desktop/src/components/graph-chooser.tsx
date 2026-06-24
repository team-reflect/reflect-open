import { useState, type ReactElement } from 'react'
import { CloudDownload, Folder, FolderPlus, Import, Loader2 } from 'lucide-react'
import { hasBridge } from '@reflect/core'
import { RestoreFromGithubDialog } from '@/components/restore-from-github-dialog'
import { Button } from '@/components/ui/button'
import { useGraphColors } from '@/hooks/use-graph-colors'
import { useGraphImport } from '@/hooks/use-graph-import'
import { graphColorCss } from '@/lib/graph-colors'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'

const V1_EXPORT_HELP =
  'Moving from Reflect V1? In V1, go to Settings > Graph > Export, export a "Reflect Open folder", then open it here.'

/**
 * First-run / no-graph screen: open a folder as a graph, or reopen a recent one.
 * Shown by `App` whenever no graph is active (Plan 02 loading gate). A recent's
 * folder icon takes the graph's identity color once one is chosen (sidebar
 * footer → Graph color); until then it stays muted.
 */
export function GraphChooser(): ReactElement {
  const { recents, error, pickAndOpen, openRecent, forget } = useGraph()
  const { colorFor } = useGraphColors()
  const { isDragging, importing, importError, clearImportError, handlers } = useGraphImport()
  const [restoring, setRestoring] = useState(false)

  // Starting any other open path drops a lingering import error, so a fresh
  // picker/recent/restore failure (provider `error`) is never hidden behind it.
  const openPicker = (): void => {
    clearImportError()
    void pickAndOpen()
  }
  const openRecentGraph = (root: string): void => {
    clearImportError()
    void openRecent(root)
  }

  return (
    <div className="flex h-screen w-screen overflow-auto bg-surface-app p-8" {...handlers}>
      {isDragging ? <DropOverlay /> : null}
      {importing ? <ImportingOverlay /> : null}
      {/* Auto margins (not items-center) so the card centers when it fits but
          scrolls from the top when the recents list outgrows the viewport —
          flex centering would clip the overflowing top edge. */}
      <div className="m-auto w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold text-text">Open a graph</h1>
          <p className="text-sm text-text-secondary">
            Pick a folder for your notes — Reflect stores them as plain markdown.
          </p>
        </div>

        <div className="space-y-2">
          <Button type="button" className="w-full" onClick={openPicker}>
            <FolderPlus aria-hidden strokeWidth={1.75} />
            Open graph…
          </Button>
          <p className="text-center text-xs leading-5 text-text-muted">
            {V1_EXPORT_HELP}
          </p>
        </div>

        {hasBridge() ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              clearImportError()
              setRestoring(true)
            }}
          >
            <CloudDownload aria-hidden strokeWidth={1.75} />
            Restore from GitHub…
          </Button>
        ) : null}

        {restoring ? <RestoreFromGithubDialog onClose={() => setRestoring(false)} /> : null}

        {importError ?? error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {importError ?? error}
          </p>
        ) : null}

        {recents.length > 0 ? (
          <div className="space-y-2">
            <p className="px-2 text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
              Recent
            </p>
            <ul className="space-y-px">
              {recents.map((recent) => {
                const color = colorFor(recent.root)
                return (
                  <li
                    key={recent.root}
                    className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors duration-100 hover:bg-surface-hover"
                  >
                    <button
                      type="button"
                      onClick={() => openRecentGraph(recent.root)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <Folder
                        aria-hidden
                        strokeWidth={1.75}
                        className={cn('size-4 shrink-0', color === undefined && 'text-text-muted')}
                        style={color === undefined ? undefined : { color: graphColorCss(color) }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text">
                          {recent.name}
                        </span>
                        <span className="block truncate text-xs text-text-muted">
                          {recent.root}
                        </span>
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => void forget(recent.root)}
                      aria-label={`Forget ${recent.name}`}
                      className="shrink-0 text-text-muted opacity-0 transition-opacity duration-100 hover:text-text-secondary group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                    >
                      Forget
                    </Button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Full-screen affordance shown while a Reflect export is dragged over the
 * chooser. Pointer-events stay off so the drag's enter/leave still resolve
 * against the underlying drop zone.
 */
function DropOverlay(): ReactElement {
  return (
    <div className="pointer-events-none fixed inset-4 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/60 bg-surface-app/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-2 text-accent">
        <Import aria-hidden strokeWidth={1.75} className="size-8" />
        <p className="text-sm font-medium">Drop to import your Reflect graph</p>
      </div>
    </div>
  )
}

/** Blocking overlay shown while a dropped export is read and materialized. */
function ImportingOverlay(): ReactElement {
  return (
    <div
      role="status"
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-app/80 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-2 text-text-secondary">
        <Loader2 aria-hidden className="size-6 animate-spin" />
        <p className="text-sm font-medium">Importing your graph…</p>
      </div>
    </div>
  )
}
