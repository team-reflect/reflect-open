import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { ListChecks, MessageSquare, SquarePen } from 'lucide-react'
import { AudioMemoButton } from '@/components/audio-memo/audio-memo-button'
import { ListIcon } from '@/components/icons/list-icon'
import { PencilIcon } from '@/components/icons/pencil-icon'
import { keybindingFor } from '@/lib/commands/app-commands'
import { runCommand } from '@/lib/commands/registry'
import { isUntitledNotePath } from '@/lib/create-note'
import type { CommandContext } from '@/lib/commands/types'
import { hasMacosTitleBarOverlay } from '@/lib/window-chrome'
import { cn } from '@/lib/utils'
import { useRouter } from '@/routing/router'
import { GraphFooter } from './graph-footer'
import { NavigateArrows } from './navigate-arrows'
import { SidebarItem } from './sidebar-item'
import { SidebarPinned } from './sidebar-pinned'
import { SidebarSearch } from './sidebar-search'

interface SidebarProps {
  graph: GraphInfo
  /** Commands run with this — the same context the palette/shortcuts use. */
  context: CommandContext
}

/**
 * The workspace sidebar, in the original app's shape: history arrows top
 * right, search, primary navigation with hover-revealed shortcut keycaps, the
 * Pinned shelf, and the graph switcher footer. Nav rows run registered
 * commands so a binding and its behavior stay one definition. (Sidebar
 * collapse stays on `Mod-\` via the command registry.)
 */
export function Sidebar({ graph, context }: SidebarProps): ReactElement {
  const { route } = useRouter()

  // Wrap the 16px Lucide glyphs in the custom icons' 24px box so nav rows
  // share one icon footprint.
  const lucideBox = 'flex size-6 shrink-0 items-center justify-center'

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col',
        // With the overlaid macOS title bar, the traffic lights and the
        // WindowDragRegion strip own the top 28px — start content below them.
        hasMacosTitleBarOverlay ? 'pt-2' : 'pt-2.5',
      )}
    >
      <div className="flex flex-none items-center justify-end px-2 pt-1">
        <NavigateArrows />
      </div>

      <div className="flex flex-none flex-col">
        <div className="mt-1 flex items-center gap-1.5 px-4">
          <div className="min-w-0 flex-1">
            <SidebarSearch onOpen={() => context.openPalette()} />
          </div>
          <AudioMemoButton />
        </div>

        <nav aria-label="Primary" className="mt-6 space-y-1 px-4">
          <SidebarItem
            icon={<PencilIcon className="shrink-0" />}
            label="Daily notes"
            binding={keybindingFor('nav.today') ?? undefined}
            active={route.kind === 'today' || route.kind === 'daily'}
            onClick={() => void runCommand('nav.today', context)}
          />
          <SidebarItem
            icon={
              <span className={lucideBox}>
                <SquarePen aria-hidden strokeWidth={1.75} className="size-4" />
              </span>
            }
            label="New note"
            binding={keybindingFor('note.new') ?? undefined}
            // Active while the open note is still on its ULID placeholder
            // name — the state this row creates. The birth rename onto a
            // title slug is also what hands the note off to ordinary
            // navigation, releasing the highlight.
            active={route.kind === 'note' && isUntitledNotePath(route.path)}
            onClick={() => void runCommand('note.new', context)}
          />
          <SidebarItem
            icon={<ListIcon className="shrink-0" />}
            label="All notes"
            binding={keybindingFor('nav.allNotes') ?? undefined}
            active={route.kind === 'allNotes'}
            onClick={() => void runCommand('nav.allNotes', context)}
          />
          <SidebarItem
            icon={
              <span className={lucideBox}>
                <ListChecks aria-hidden strokeWidth={1.75} className="size-4" />
              </span>
            }
            label="Tasks"
            binding={keybindingFor('nav.tasks') ?? undefined}
            active={route.kind === 'tasks'}
            onClick={() => void runCommand('nav.tasks', context)}
          />
          <SidebarItem
            icon={
              <span className={lucideBox}>
                <MessageSquare aria-hidden strokeWidth={1.75} className="size-4" />
              </span>
            }
            label="Chat"
            binding={keybindingFor('chat.open') ?? undefined}
            active={route.kind === 'chat'}
            onClick={() => void runCommand('chat.open', context)}
          />
        </nav>
      </div>

      <div className="mt-1 min-h-0 flex-1 overflow-y-auto pb-2">
        <SidebarPinned />
      </div>

      <GraphFooter graph={graph} context={context} />
    </div>
  )
}
