import type { ReactElement } from 'react'
import type { RecentGraph } from '@reflect/core'
import { Check } from 'lucide-react'
import { GraphSwatch } from '@/components/graph-swatch'
import { ShortcutKeys } from '@/components/shortcut-keys'
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useGraphColors } from '@/hooks/use-graph-colors'
import { DEFAULT_GRAPH_COLOR, GRAPH_COLOR_OPTIONS } from '@/lib/graph-colors'

interface GraphMenuItemProps {
  graph: RecentGraph
  current: boolean
  binding: string | null
  onSelect: () => void
}

/** A recent graph with separate color and switch actions in the same row. */
export function GraphMenuItem({
  graph,
  current,
  binding,
  onSelect,
}: GraphMenuItemProps): ReactElement {
  const { colorFor, setColor } = useGraphColors()
  const color = colorFor(graph.root) ?? DEFAULT_GRAPH_COLOR

  return (
    <div className="flex h-8 items-stretch">
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          aria-label={`Change color for ${graph.name}`}
          label={`Change color for ${graph.name}`}
          openOnHover={false}
          showChevron={false}
          className="shrink-0 justify-center px-2 py-0"
        >
          <GraphSwatch color={color} className="size-3.5 rounded" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent aria-label={`Color for ${graph.name}`}>
          <DropdownMenuRadioGroup value={color}>
            {GRAPH_COLOR_OPTIONS.map((option) => (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                closeOnClick
                onClick={() => setColor(graph.root, option.id)}
                className="h-8 gap-2 py-0 pl-2 text-[13px] text-text-secondary"
              >
                <GraphSwatch color={option.id} className="size-3.5 rounded" />
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <Tooltip>
        <TooltipTrigger
          delay={700}
          render={
            <DropdownMenuItem
              onClick={onSelect}
              className="min-w-0 flex-1 gap-2 py-0 pr-2 pl-0 text-[13px] text-text-secondary"
            >
              <span className="min-w-0 flex-1 truncate">{graph.name}</span>
              {current ? (
                <Check aria-hidden className="size-3.5 shrink-0 text-accent" />
              ) : binding !== null ? (
                <ShortcutKeys binding={binding} className="text-[10px]" />
              ) : null}
            </DropdownMenuItem>
          }
        />
        <TooltipContent side="right">{graph.root}</TooltipContent>
      </Tooltip>
    </div>
  )
}
