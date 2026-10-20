import { useRef, useState, type ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { FolderOpen, GraduationCap, LocateFixed, PanelsTopLeft, Settings } from 'lucide-react'
import { CountdownText } from '@/components/countdown-text.tsx'
import { GraphSwatch } from '@/components/graph-swatch.tsx'
import { ReflectAppsDialog } from '@/components/reflect-apps-dialog.tsx'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'
import { GraphMenuItem } from '@/components/sidebar/graph-menu-item.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useGraphColors } from '@/hooks/use-graph-colors.ts'
import { keybindingFor } from '@/lib/commands/app-commands.ts'
import type { CommandContext } from '@/lib/commands/types.ts'
import { cn } from '@/lib/utils.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useGitSync, type GitSyncState } from '@/providers/sync-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

const MENU_ITEM_CLASS = 'h-8 gap-2 px-2 py-0 text-[13px] text-text-secondary'
const SETTINGS_BINDING = keybindingFor('settings.open')

function graphSwitchBindingFor(index: number): string | null {
  // Recent rows are zero-based; `graph.switchN` commands and keycaps are one-based.
  return keybindingFor(`graph.switch${index + 1}`)
}

/** The quiet git sync indicator: a dot and a screen-reader label, nothing when idle. */
function GitSyncDot({ state }: { state: GitSyncState }): ReactElement | null {
  if (state.phase !== 'connected' || state.status.state === 'idle') {
    return null
  }
  const status = state.status
  const { className, label } = {
    syncing: { className: 'bg-accent motion-safe:animate-pulse', label: 'Backing up' },
    waiting: { className: 'bg-text-muted', label: 'Backup scheduled' },
    offline: { className: 'bg-amber-500', label: 'Backup waiting for a connection' },
    error: { className: 'bg-red-500', label: 'Backup failed — see Settings' },
  }[status.state]
  return (
    <>
      <span aria-hidden className={cn('h-1.5 w-1.5 flex-none rounded-full', className)} />
      <span role="status" className="sr-only">
        {label}
      </span>
      {status.state === 'waiting' ? (
        <span className="sr-only">
          Backs up in <CountdownText until={status.until} />
        </span>
      ) : null}
    </>
  )
}

interface GraphFooterProps {
  graph: GraphInfo
  /** Commands run with this — the same context the palette/shortcuts use. */
  context: CommandContext
}

/**
 * The sidebar footer: the graph's color swatch and name open a dropdown for
 * switching and recoloring graphs, settings, companion app installs, and Reflect Academy.
 * The swatch pulses while the graph indexes; a small dot reports backup state.
 * Menu content matches the trigger width to stay inset from the sidebar edges.
 */
export function GraphFooter({ graph, context }: GraphFooterProps): ReactElement {
  const [appsOpen, setAppsOpen] = useState(false)
  const graphTriggerRef = useRef<HTMLButtonElement>(null)
  const { logger } = useCoreServices()
  const { opener, window: appWindow } = useAppServices()
  const { recents, indexing, openRecent, chooseGraph } = useGraph()
  const { colorFor } = useGraphColors()
  const { state } = useGitSync()
  const { route } = useRouter()
  const settingsActive = route.kind === 'settings'

  return (
    <div className="flex items-center gap-1 px-4 py-3">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            delay={700}
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    ref={graphTriggerRef}
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
                    <GitSyncDot state={state} />
                    {indexing ? (
                      <span role="status" className="sr-only">
                        Indexing
                      </span>
                    ) : null}
                  </Button>
                }
              />
            }
          />
          <TooltipContent>{graph.root}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent aria-label="Switch graph" side="top" sideOffset={6}>
          {recents.map((recent, index) => (
            <GraphMenuItem
              key={recent.root}
              graph={recent}
              current={recent.root === graph.root}
              binding={graphSwitchBindingFor(index)}
              onSelect={() => {
                if (recent.root !== graph.root) {
                  void openRecent(recent.root)
                }
              }}
            />
          ))}
          {recents.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem
            onClick={() => {
              void opener.revealInFileManager(graph.root).catch((cause: unknown) => {
                logger.error('open graph folder failed:', cause)
              })
            }}
            className={MENU_ITEM_CLASS}
          >
            <LocateFixed aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Reveal graph in Finder</span>
          </DropdownMenuItem>
          {/* Graph switching re-roots every window; note windows hide it. */}
          {appWindow.isMainWindow() ? (
            <DropdownMenuItem onClick={() => void chooseGraph()} className={MENU_ITEM_CLASS}>
              <FolderOpen aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Open another graph…</span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void context.app.commands.run('settings.open', context)}
            className={MENU_ITEM_CLASS}
          >
            <Settings aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Preferences</span>
            {SETTINGS_BINDING && (
              <ShortcutKeys binding={SETTINGS_BINDING} className="text-[10px]" />
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAppsOpen(true)} className={MENU_ITEM_CLASS}>
            <PanelsTopLeft aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Get Reflect apps…</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => opener.openUrlSync('https://reflect.academy')}
            className={MENU_ITEM_CLASS}
          >
            <GraduationCap aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Reflect Academy</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open settings"
              aria-current={settingsActive ? 'page' : undefined}
              onClick={() => void context.app.commands.run('settings.open', context)}
              className={cn(
                'size-7 shrink-0 text-text-muted transition-colors duration-100 hover:bg-surface-hover hover:text-text-secondary',
                settingsActive
                  ? 'bg-surface-hover text-text dark:bg-transparent dark:text-accent'
                  : null,
              )}
            >
              <Settings aria-hidden strokeWidth={1.75} className="size-4" />
            </Button>
          }
        />
        <TooltipContent>
          Settings {SETTINGS_BINDING && <ShortcutKeys binding={SETTINGS_BINDING} />}
        </TooltipContent>
      </Tooltip>
      <ReflectAppsDialog open={appsOpen} onOpenChange={setAppsOpen} finalFocus={graphTriggerRef} />
    </div>
  )
}
