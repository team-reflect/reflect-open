import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { ListChecks, MessageSquare, SquarePen } from 'lucide-react'
import { AudioMemoButton } from '@/components/audio-memo/audio-memo-button.tsx'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { ListIcon } from '@/components/icons/list-icon.tsx'
import { PencilIcon } from '@/components/icons/pencil-icon.tsx'
import { useModKeyHeld } from '@/hooks/use-mod-key-held.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { useToday } from '@/lib/use-today.ts'
import { cn } from '@/lib/utils.ts'
import { APP_COMMANDS, notePathForRoute, rootSectionForRoute } from '@reflect/app'
import { useRouterActions, useRouterState } from '@/routing/router.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { GraphFooter } from './graph-footer.tsx'
import { NavigateArrows } from './navigate-arrows.tsx'
import { SidebarItem } from './sidebar-item.tsx'
import { SidebarPinned } from './sidebar-pinned.tsx'
import { SidebarSearch } from './sidebar-search.tsx'

interface SidebarProps {
  graph: GraphInfo
}

const NEW_NOTE_BINDING = APP_COMMANDS['note.new'].keybinding
const TODAY_BINDING = APP_COMMANDS['nav.today'].keybinding
const ALL_NOTES_BINDING = APP_COMMANDS['nav.allNotes'].keybinding
const TASKS_BINDING = APP_COMMANDS['nav.tasks'].keybinding
const CHAT_BINDING = APP_COMMANDS['chat.open'].keybinding

/**
 * The workspace sidebar, in the original app's shape: history arrows top
 * right, search with the compose and audio memo buttons, primary navigation with hover-revealed shortcut keycaps
 * (or all at once while `Mod` is held), the Pinned shelf, and the graph switcher footer. Nav rows run registered
 * commands so a binding and its behavior stay one definition, and light for
 * the section of the screen on view. Daily notes is the exception: off the
 * stream it returns to the stream's last day, and on it it is the `Mod-D`
 * capture gesture (today, caret at the end). (Sidebar collapse stays on
 * `Mod-\` via the command registry.)
 */
export function Sidebar({ graph }: SidebarProps): ReactElement {
  const { platform } = useCoreServices()
  const { commands } = useAppServices()
  const { selectSection } = useRouterActions()
  const { route, section } = useRouterState()
  const onDailySurface = route.kind === 'today' || route.kind === 'daily'
  const today = useToday()
  const pinned = usePinnedNotes()
  const modHeld = useModKeyHeld(platform.isApplePlatform)
  const currentNotePath = notePathForRoute(route, today)
  const hasActivePinnedNote =
    currentNotePath !== null && pinned.some((note) => note.path === currentNotePath)
  // A section row lights for the section of the screen on view. An open
  // pinned note lights its own row instead; the settings screens light none.
  const sectionRowsLit =
    (rootSectionForRoute(route) !== null || route.kind === 'note') && !hasActivePinnedNote

  // Wrap the 16px Lucide glyphs in the custom icons' 24px box so nav rows
  // share one icon footprint.
  const lucideBox = 'flex size-6 shrink-0 items-center justify-center'

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col',
        // With the overlaid macOS title bar, the traffic lights and the
        // WindowDragRegion strip own the top 28px — start content below them.
        platform.hasMacosTitleBarOverlay ? 'pt-2' : 'pt-2.5',
      )}
    >
      <div className="flex flex-none items-center justify-end px-2 pt-1">
        <NavigateArrows />
      </div>

      <div className="flex flex-none flex-col">
        <div className="mt-1 flex items-center gap-1.5 px-4">
          <div className="min-w-0 flex-1">
            <SidebarSearch onOpen={() => commands.run('palette.open')} />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New note"
                  onClick={() => commands.run('note.new')}
                  className="text-text-muted hover:text-text-secondary dark:hover:text-text"
                >
                  <SquarePen aria-hidden strokeWidth={1.75} className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="bottom">
              New note <ShortcutKeys binding={NEW_NOTE_BINDING} />
            </TooltipContent>
          </Tooltip>
          <AudioMemoButton />
        </div>

        <nav aria-label="Primary" className="mt-6 space-y-1 px-4">
          <SidebarItem
            icon={<PencilIcon className="shrink-0" />}
            label="Daily notes"
            binding={TODAY_BINDING}
            revealBinding={modHeld}
            active={sectionRowsLit && section === 'daily'}
            onClick={() => {
              if (onDailySurface) {
                void commands.run('nav.today')
              } else {
                selectSection('daily')
              }
            }}
          />
          <SidebarItem
            icon={<ListIcon className="shrink-0" />}
            label="All notes"
            binding={ALL_NOTES_BINDING}
            revealBinding={modHeld}
            active={sectionRowsLit && section === 'all'}
            onClick={() => commands.run('nav.allNotes')}
          />
          <SidebarItem
            icon={
              <span className={lucideBox}>
                <ListChecks aria-hidden strokeWidth={1.75} className="size-4" />
              </span>
            }
            label="Tasks"
            binding={TASKS_BINDING}
            revealBinding={modHeld}
            active={sectionRowsLit && section === 'tasks'}
            onClick={() => commands.run('nav.tasks')}
          />
          <SidebarItem
            icon={
              <span className={lucideBox}>
                <MessageSquare aria-hidden strokeWidth={1.75} className="size-4" />
              </span>
            }
            label="Chat"
            binding={CHAT_BINDING}
            revealBinding={modHeld}
            active={sectionRowsLit && section === 'chat'}
            onClick={() => commands.run('chat.open')}
          />
        </nav>
      </div>

      <div className="mt-1 min-h-0 flex-1 overflow-y-auto pb-2">
        <SidebarPinned showShortcuts={modHeld} />
      </div>

      <GraphFooter graph={graph} />
    </div>
  )
}
