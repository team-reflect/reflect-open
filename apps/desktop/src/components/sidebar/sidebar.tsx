import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { CalendarDays, PanelLeftClose, Settings, SquarePen } from 'lucide-react'
import { runCommand } from '@/lib/commands/registry'
import type { CommandContext } from '@/lib/commands/types'
import { formatBindingLabel } from '@/lib/keybindings'
import { useRouter } from '@/routing/router'
import { GraphFooter } from './graph-footer'
import { SidebarItem } from './sidebar-item'
import { SidebarRecents } from './sidebar-recents'
import { SidebarSearch } from './sidebar-search'

interface SidebarProps {
  graph: GraphInfo
  /** Commands run with this — the same context the palette/shortcuts use. */
  context: CommandContext
}

/**
 * The workspace sidebar, in the original app's shape: search up top, primary
 * navigation with hover-revealed shortcut keycaps, a Recents feed, and the
 * graph switcher footer. Nav rows run registered commands so a binding and
 * its behavior stay one definition.
 */
export function Sidebar({ graph, context }: SidebarProps): ReactElement {
  const { route } = useRouter()
  return (
    <div className="flex h-full min-h-0 flex-col px-3 pt-2.5 pb-3">
      <div className="flex items-center justify-end pb-1.5">
        <button
          type="button"
          aria-label="Hide sidebar"
          title={`Hide sidebar (${formatBindingLabel('Mod-\\')})`}
          onClick={() => context.toggleSidebar()}
          className="rounded-md p-1 text-[color:var(--text-muted)] transition-colors duration-100 hover:bg-[var(--surface-hover)] hover:text-[color:var(--text-secondary)]"
        >
          <PanelLeftClose aria-hidden strokeWidth={1.75} className="size-4" />
        </button>
      </div>

      <SidebarSearch onOpen={() => context.openPalette()} />

      <nav aria-label="Primary" className="flex flex-col gap-px pt-3">
        <SidebarItem
          icon={CalendarDays}
          label="Today"
          binding="Mod-d"
          active={route.kind === 'today' || route.kind === 'daily'}
          onClick={() => void runCommand('nav.today', context)}
        />
        <SidebarItem
          icon={SquarePen}
          label="New note"
          binding="Mod-n"
          onClick={() => void runCommand('note.new', context)}
        />
        <SidebarItem
          icon={Settings}
          label="Settings"
          binding="Mod-,"
          active={route.kind === 'settings'}
          onClick={() => void runCommand('settings.open', context)}
        />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarRecents />
      </div>

      <GraphFooter graph={graph} />
    </div>
  )
}
