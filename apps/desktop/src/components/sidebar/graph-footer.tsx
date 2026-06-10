import { useState, type ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { Check, ChevronsUpDown, FolderOpen } from 'lucide-react'
import { useGraph } from '@/providers/graph-provider'

/**
 * The sidebar footer, in the original app's idiom (its account/workspace
 * switcher): which graph you're in, and the way to another one — recent
 * graphs plus the OS folder picker, in a lightweight disclosure. No portal:
 * the footer is its own positioning context, and a fixed backdrop handles
 * click-outside.
 */
export function GraphFooter({ graph }: { graph: GraphInfo }): ReactElement {
  const { recents, indexing, openRecent, pickAndOpen } = useGraph()
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

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={graph.root}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-100 hover:bg-surface-hover"
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-hover text-xs font-semibold text-accent"
        >
          {graph.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-text">
            {graph.name}
          </span>
          {indexing ? (
            <span
              role="status"
              className="block truncate text-[11px] text-text-muted motion-safe:animate-pulse"
            >
              Indexing…
            </span>
          ) : null}
        </span>
        <ChevronsUpDown
          aria-hidden
          strokeWidth={1.75}
          className="size-3.5 shrink-0 text-text-muted"
        />
      </button>
    </div>
  )
}
