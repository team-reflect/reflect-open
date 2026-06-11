import { useState, type ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { Check, FolderOpen } from 'lucide-react'
import { HelpIcon } from '@/components/icons/help-icon'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'
import { useRouter } from '@/routing/router'

/**
 * The sidebar footer, in the original app's idiom (its account nav): the
 * graph's color swatch and name on the left — a disclosure for switching to a
 * recent graph or the OS folder picker — and a help button on the right
 * (Settings hosts the keyboard cheat sheet, the closest analog to the old
 * help menu). The swatch pulses while the graph indexes. No portal: the
 * footer is its own positioning context, and a fixed backdrop handles
 * click-outside.
 */
export function GraphFooter({ graph }: { graph: GraphInfo }): ReactElement {
  const { recents, indexing, openRecent, pickAndOpen } = useGraph()
  const { navigate } = useRouter()
  const [open, setOpen] = useState(false)

  const choose = (action: () => Promise<void>): void => {
    setOpen(false)
    void action()
  }

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
        }
      }}
    >
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close graph menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />
          <div
            role="menu"
            aria-label="Switch graph"
            className="absolute inset-x-0 bottom-full z-30 mb-1.5 rounded-lg border border-border bg-surface p-1 shadow-pop"
          >
            {recents.map((recent) => {
              const current = recent.root === graph.root
              return (
                <button
                  key={recent.root}
                  type="button"
                  role="menuitem"
                  title={recent.root}
                  onClick={() => {
                    if (current) {
                      setOpen(false)
                      return
                    }
                    choose(() => openRecent(recent.root))
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text"
                >
                  <span className="min-w-0 flex-1 truncate text-left">{recent.name}</span>
                  {current ? (
                    <Check aria-hidden className="size-3.5 shrink-0 text-accent" />
                  ) : null}
                </button>
              )
            })}
            {recents.length > 0 ? (
              <div role="separator" className="mx-2 my-1 border-t border-border" />
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(pickAndOpen)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              <FolderOpen aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">Open another graph…</span>
            </button>
          </div>
        </>
      ) : null}

      <div className="flex items-center px-4 py-3">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          title={graph.root}
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center space-x-2.5 text-left"
        >
          <span
            aria-hidden
            className={cn(
              'h-5 w-5 flex-none rounded-md bg-accent',
              indexing && 'motion-safe:animate-pulse',
            )}
          />
          <span className="min-w-0 truncate text-sm font-medium text-text">
            {graph.name}
          </span>
          {indexing ? (
            <span role="status" className="sr-only">
              Indexing
            </span>
          ) : null}
        </button>
        <button
          type="button"
          aria-label="Help"
          title="Help"
          onClick={() => navigate({ kind: 'settings' })}
          className="flex-none text-text-muted transition-colors duration-100 hover:text-text"
        >
          <HelpIcon />
        </button>
      </div>
    </div>
  )
}
