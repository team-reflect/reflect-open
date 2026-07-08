import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { Check, FolderOpen, LocateFixed, Settings } from 'lucide-react'
import { GraphSwatch } from '@/components/graph-swatch'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Button } from '@/components/ui/button'
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
import { keybindingFor } from '@/lib/commands/app-commands'
import { runCommand } from '@/lib/commands/registry'
import type { CommandContext } from '@/lib/commands/types'
import { DEFAULT_GRAPH_COLOR, GRAPH_COLOR_OPTIONS } from '@/lib/graph-colors'
import { cn } from '@/lib/utils'
import { isMainWindow } from '@/lib/windows/window-role'
import { useGraph } from '@/providers/graph-provider'
import { useSync, type BackupState } from '@/providers/sync-provider'
import { useRouter } from '@/routing/router'

const MENU_ITEM_CLASS = 'gap-2 px-2 py-1.5 text-[13px] text-text-secondary'
const SETTINGS_BINDING = keybindingFor('settings.open')

function graphSwitchBindingFor(index: number): string | null {
  // Recent rows are zero-based; `graph.switchN` commands and keycaps are one-based.
  return keybindingFor(`graph.switch${index + 1}`)
}

/**
 * The quiet backup indicator: nothing when backed up (or not set up), a
 * pulsing accent dot while backing up, amber when offline with queued
 * changes, red when backup needs attention. Detail lives in Settings.
 */
function backupDot(backup: BackupState): { className: string; label: string } | null {
  if (backup.phase !== 'connected' || backup.status.state === 'idle') {
    return null
  }
  switch (backup.status.state) {
    case 'syncing':
      return { className: 'bg-accent motion-safe:animate-pulse', label: 'Backing up' }
    case 'offline':
      return { className: 'bg-amber-500', label: 'Backup waiting for a connection' }
    case 'error':
      return { className: 'bg-red-500', label: 'Backup failed — see Settings' }
  }
}

/**
 * The sidebar footer: the graph's color swatch and name on the left — a
 * dropdown menu for switching to a recent graph, recoloring this graph, or
 * the OS folder picker. The swatch pulses while the graph indexes; a small
 * dot reports backup state. The menu content matches the trigger width, so
 * it stays inset from the sidebar edges.
 */
interface GraphFooterProps {
  graph: GraphInfo
  /** Commands run with this — the same context the palette/shortcuts use. */
  context: CommandContext
}

export function GraphFooter({ graph, context }: GraphFooterProps): ReactElement {
  const { recents, indexing, openRecent, chooseGraph } = useGraph()
  const { colorFor, setColor } = useGraphColors()
  const currentColor = colorFor(graph.root) ?? DEFAULT_GRAPH_COLOR
  const { backup } = useSync()
  const { route } = useRouter()
  const dot = backupDot(backup)
  const settingsActive = route.kind === 'settings'

  return (
    <div className="flex items-center gap-1 px-4 py-3">
      <DropdownMenu>
        <Tooltip delayDuration={700}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="group h-auto min-w-0 flex-1 justify-start gap-2.5 px-1.5 py-1 text-left"
              >
                <GraphSwatch
                  color={colorFor(graph.root)}
                  className={cn('h-5 w-5', indexing && 'motion-safe:animate-pulse')}
                />
                <span className="min-w-0 truncate text-xs font-medium text-text-secondary transition-colors duration-100 group-hover:text-text">
                  {graph.name}
                </span>
                {dot !== null ? (
                  <>
                    <span
                      aria-hidden
                      className={cn('h-1.5 w-1.5 flex-none rounded-full', dot.className)}
                    />
                    <span role="status" className="sr-only">
                      {dot.label}
                    </span>
                  </>
                ) : null}
                {indexing ? (
                  <span role="status" className="sr-only">
                    Indexing
                  </span>
                ) : null}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{graph.root}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent aria-label="Switch graph" side="top" sideOffset={6}>
          {recents.map((recent, index) => {
            const current = recent.root === graph.root
            const binding = graphSwitchBindingFor(index)
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
                    ) : binding !== null ? (
                      <ShortcutKeys binding={binding} className="text-[10px]" />
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
            onSelect={() => {
              void revealItemInDir(graph.root).catch((cause: unknown) => {
                console.error('open graph folder failed:', cause)
              })
            }}
            className={MENU_ITEM_CLASS}
          >
            <LocateFixed aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Reveal graph in Finder</span>
          </DropdownMenuItem>
          {/* Graph switching re-roots every window; note windows hide it. */}
          {isMainWindow() ? (
            <DropdownMenuItem
              onSelect={() => void chooseGraph()}
              className={MENU_ITEM_CLASS}
            >
              <FolderOpen aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Open another graph…</span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={() => void runCommand('settings.open', context)}
            className={MENU_ITEM_CLASS}
          >
            <Settings aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">User settings</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open settings"
            aria-current={settingsActive ? 'page' : undefined}
            onClick={() => void runCommand('settings.open', context)}
            className={cn(
              'size-7 shrink-0 text-text-muted transition-colors duration-100 hover:bg-surface-hover hover:text-text-secondary',
              settingsActive
                ? 'bg-surface-hover text-text dark:bg-transparent dark:text-accent'
                : null,
            )}
          >
            <Settings aria-hidden strokeWidth={1.75} className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Settings {SETTINGS_BINDING && <ShortcutKeys binding={SETTINGS_BINDING} />}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
