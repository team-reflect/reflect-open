import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { CalendarDays, Files, PanelLeftClose, Settings, SquarePen } from 'lucide-react'
import { keybindingFor } from '@/lib/commands/app-commands'
import { runCommand } from '@/lib/commands/registry'
import type { CommandContext } from '@/lib/commands/types'
import { formatBindingLabel } from '@/lib/keybindings'
import { hasMacosTitleBarOverlay } from '@/lib/window-chrome'
import { cn } from '@/lib/utils'
import { useRouter } from '@/routing/router'
import { GraphFooter } from './graph-footer'
import { SidebarItem } from './sidebar-item'
import { SidebarPinned } from './sidebar-pinned'
import { SidebarRecents } from './sidebar-recents'
import { SidebarSearch } from './sidebar-search'

interface SidebarProps {
  graph: GraphInfo
  /** Commands run with this — the same context the palette/shortcuts use. */
  context: CommandContext
}

/**
 * The workspace sidebar, in the original app's shape: search up top, primary
 * navigation with hover-revealed shortcut keycaps, the Pinned shelf, the
 * Recents feed, and the graph switcher footer. Nav rows run registered
 * commands so a binding and its behavior stay one definition.
 */
const SIDEBAR_TOGGLE_BINDING = keybindingFor('sidebar.toggle')

export function Sidebar({ graph, context }: SidebarProps): ReactElement {
  const { route } = useRouter()
  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col px-3 pb-3',
        // With the overlaid macOS title bar, the traffic lights and the
        // WindowDragRegion strip own the top 28px — start content below them.
        hasMacosTitleBarOverlay ? 'pt-7' : 'pt-2.5',
      )}
    >
      <div className="flex items-center justify-end pb-1.5">
        <button
          type="button"
          aria-label="Hide sidebar"
          title={
            SIDEBAR_TOGGLE_BINDING !== null
              ? `Hide sidebar (${formatBindingLabel(SIDEBAR_TOGGLE_BINDING)})`
              : 'Hide sidebar'
          }
          onClick={() => context.toggleSidebar()}
          className="rounded-md p-1 text-text-muted transition-colors duration-100 hover:bg-surface-hover hover:text-text-secondary"
        >
          <PanelLeftClose aria-hidden strokeWidth={1.75} className="size-4" />
        </button>
      </div>

      <SidebarSearch onOpen={() => context.openPalette()} />

      <nav aria-label="Primary" className="flex flex-col gap-px pt-3">
        <SidebarItem
          icon={CalendarDays}
          label="Today"
          binding={keybindingFor('nav.today') ?? undefined}
          active={route.kind === 'today' || route.kind === 'daily'}
          onClick={() => void runCommand('nav.today', context)}
        />
        <SidebarItem
          icon={Files}
          label="All notes"
          binding={keybindingFor('nav.allNotes') ?? undefined}
          active={route.kind === 'allNotes'}
          onClick={() => void runCommand('nav.allNotes', context)}
        />
        <SidebarItem
          icon={SquarePen}
          label="New note"
          binding={keybindingFor('note.new') ?? undefined}
          onClick={() => void runCommand('note.new', context)}
        />
        <SidebarItem
          icon={Settings}
          label="Settings"
          binding={keybindingFor('settings.open') ?? undefined}
          active={route.kind === 'settings'}
          onClick={() => void runCommand('settings.open', context)}
        />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarPinned />
        <SidebarRecents />
      </div>

      <GraphFooter graph={graph} />
    </div>
  )
}
