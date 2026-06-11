import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { Check, FolderOpen } from 'lucide-react'
import { HelpIcon } from '@/components/icons/help-icon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'
import { useRouter } from '@/routing/router'

const MENU_ITEM_CLASS = 'gap-2 px-2 py-1.5 text-[13px] text-text-secondary'

/**
 * The sidebar footer, in the original app's idiom (its account nav): the
 * graph's color swatch and name on the left — a dropdown menu for switching
 * to a recent graph or the OS folder picker — and a help button on the right
 * (Settings hosts the keyboard cheat sheet, the closest analog to the old
 * help menu). The swatch pulses while the graph indexes. The menu content
 * matches the trigger width, so it stays inset from the sidebar edges.
 */
export function GraphFooter({ graph }: { graph: GraphInfo }): ReactElement {
  const { recents, indexing, openRecent, pickAndOpen } = useGraph()
  const { navigate } = useRouter()

  return (
    <div className="flex items-center px-4 py-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={graph.root}
            className="flex min-w-0 flex-1 items-center space-x-2.5 text-left"
          >
            <span
              aria-hidden
              className={cn(
                'h-5 w-5 flex-none rounded-md bg-accent',
                indexing && 'motion-safe:animate-pulse',
              )}
            />
            <span className="min-w-0 truncate text-xs font-medium text-text">
              {graph.name}
            </span>
            {indexing ? (
              <span role="status" className="sr-only">
                Indexing
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Switch graph" side="top" sideOffset={6}>
          {recents.map((recent) => {
            const current = recent.root === graph.root
            return (
              <DropdownMenuItem
                key={recent.root}
                title={recent.root}
                onSelect={() => {
                  if (!current) {
                    void openRecent(recent.root)
                  }
                }}
                className={MENU_ITEM_CLASS}
              >
                <span className="min-w-0 flex-1 truncate">{recent.name}</span>
                {current ? (
                  <Check aria-hidden className="size-3.5 shrink-0 text-accent" />
                ) : null}
              </DropdownMenuItem>
            )
          })}
          {recents.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem
            onSelect={() => void pickAndOpen()}
            className={MENU_ITEM_CLASS}
          >
            <FolderOpen aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Open another graph…</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
  )
}
