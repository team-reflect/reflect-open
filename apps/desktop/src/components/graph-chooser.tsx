import { type ReactElement } from 'react'
import { Folder, FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGraphColors } from '@/hooks/use-graph-colors'
import { graphColorCss } from '@/lib/graph-colors'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'

/**
 * First-run / no-graph screen: open a folder as a graph, or reopen a recent one.
 * Shown by `App` whenever no graph is active (Plan 02 loading gate). A recent's
 * folder icon takes the graph's identity color once one is chosen (sidebar
 * footer → Graph color); until then it stays muted.
 */
export function GraphChooser(): ReactElement {
  const { recents, error, pickAndOpen, openRecent, forget } = useGraph()
  const { colorFor } = useGraphColors()

  return (
    <div className="flex h-screen w-screen overflow-auto bg-surface-app p-8">
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

        <Button
          type="button"
          className="w-full"
          onClick={() => void pickAndOpen()}
        >
          <FolderPlus aria-hidden strokeWidth={1.75} />
          Open graph…
        </Button>

        {error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
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
                      onClick={() => void openRecent(recent.root)}
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
