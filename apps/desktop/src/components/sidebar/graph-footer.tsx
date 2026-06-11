import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { Check, FolderOpen } from 'lucide-react'
import { GraphSwatch } from '@/components/graph-swatch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useGraphColors } from '@/hooks/use-graph-colors'
import { DEFAULT_GRAPH_COLOR, GRAPH_COLOR_OPTIONS } from '@/lib/graph-colors'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'

const MENU_ITEM_CLASS = 'gap-2 px-2 py-1.5 text-[13px] text-text-secondary'

/**
 * The sidebar footer: the graph's color swatch and name on the left — a
 * dropdown menu for switching to a recent graph, recoloring this graph, or
 * the OS folder picker. The swatch pulses while the graph indexes. The menu
 * content matches the trigger width, so it stays inset from the sidebar edges.
 */
export function GraphFooter({ graph }: { graph: GraphInfo }): ReactElement {
  const { recents, indexing, openRecent, pickAndOpen } = useGraph()
  const { colorFor, setColor } = useGraphColors()
  const currentColor = colorFor(graph.root) ?? DEFAULT_GRAPH_COLOR

  return (
    <div className="flex items-center px-4 py-3">
      <DropdownMenu>
        <Tooltip delayDuration={700}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center space-x-2.5 text-left"
              >
                <GraphSwatch
                  color={colorFor(graph.root)}
                  className={cn('h-5 w-5', indexing && 'motion-safe:animate-pulse')}
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
          </TooltipTrigger>
          <TooltipContent>{graph.root}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent aria-label="Switch graph" side="top" sideOffset={6}>
          {recents.map((recent) => {
            const current = recent.root === graph.root
            return (
              <Tooltip key={recent.root} delayDuration={700}>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onSelect={() => {
                      if (!current) {
                        void openRecent(recent.root)
                      }
                    }}
                    className={MENU_ITEM_CLASS}
                  >
                    <GraphSwatch color={colorFor(recent.root)} className="size-3.5 rounded" />
                    <span className="min-w-0 flex-1 truncate">{recent.name}</span>
                    {current ? (
                      <Check aria-hidden className="size-3.5 shrink-0 text-accent" />
                    ) : null}
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="right">{recent.root}</TooltipContent>
              </Tooltip>
            )
          })}
          {recents.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={MENU_ITEM_CLASS}>
              <GraphSwatch color={currentColor} className="size-3.5 rounded" />
              <span className="min-w-0 flex-1 truncate">Graph color</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent aria-label="Graph color">
              {GRAPH_COLOR_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  onSelect={() => setColor(graph.root, option.id)}
                  className={MENU_ITEM_CLASS}
                >
                  <GraphSwatch color={option.id} className="size-3.5 rounded" />
                  <span className="min-w-0 flex-1">{option.label}</span>
                  {option.id === currentColor ? (
                    <Check aria-hidden className="size-3.5 shrink-0 text-accent" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onSelect={() => void pickAndOpen()}
            className={MENU_ITEM_CLASS}
          >
            <FolderOpen aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Open another graph…</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
