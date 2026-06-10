import { type ReactElement } from 'react'
import { Folder, FolderPlus } from 'lucide-react'
import { useGraph } from '@/providers/graph-provider'

/**
 * First-run / no-graph screen: open a folder as a graph, or reopen a recent one.
 * Shown by `App` whenever no graph is active (Plan 02 loading gate).
 */
export function GraphChooser(): ReactElement {
  const { recents, error, pickAndOpen, openRecent, forget } = useGraph()

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--surface-app)] p-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold text-[color:var(--text)]">Open a graph</h1>
          <p className="text-sm text-[color:var(--text-secondary)]">
            Pick a folder for your notes — Reflect stores them as plain markdown.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void pickAndOpen()}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--text-on-brand,#fff)] shadow-[var(--shadow-sm)] transition-colors duration-100 hover:bg-[var(--accent-hover)]"
        >
          <FolderPlus aria-hidden strokeWidth={1.75} className="size-4" />
          Open graph…
        </button>

        {error ? (
          <p role="alert" className="text-center text-sm text-[color:var(--destructive)]">
            {error}
          </p>
        ) : null}

        {recents.length > 0 ? (
          <div className="space-y-2">
            <p className="px-2 text-[11px] font-semibold tracking-[0.08em] text-[color:var(--text-muted)] uppercase">
              Recent
            </p>
            <ul className="space-y-px">
              {recents.map((recent) => (
                <li
                  key={recent.root}
                  className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors duration-100 hover:bg-[var(--surface-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => void openRecent(recent.root)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <Folder
                      aria-hidden
                      strokeWidth={1.75}
                      className="size-4 shrink-0 text-[color:var(--text-muted)]"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-[color:var(--text)]">
                        {recent.name}
                      </span>
                      <span className="block truncate text-xs text-[color:var(--text-muted)]">
                        {recent.root}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void forget(recent.root)}
                    aria-label={`Forget ${recent.name}`}
                    className="shrink-0 rounded text-xs text-[color:var(--text-muted)] opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 hover:text-[color:var(--text-secondary)]"
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}
