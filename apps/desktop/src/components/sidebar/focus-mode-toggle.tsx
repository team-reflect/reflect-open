import type { ReactElement } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { keybindingFor } from '@/lib/commands/app-commands'
import { runCommand } from '@/lib/commands/registry'
import { cn } from '@/lib/utils'
import type { CommandContext } from '@/lib/commands/types'

const FOCUS_MODE_BINDING = keybindingFor('sidebar.toggle')

interface FocusModeToggleProps {
  /** The shared app command context, so this matches the palette and shortcut behavior. */
  context: CommandContext
  /** Whether the sidebars are currently hidden. */
  collapsed: boolean
  className?: string
}

/**
 * The visible companion to the focus-mode shortcut. It lives in the sidebar
 * while expanded and remains available over the note pane to restore chrome.
 */
export function FocusModeToggle({
  context,
  collapsed,
  className,
}: FocusModeToggleProps): ReactElement {
  const label = collapsed ? 'Exit focus mode' : 'Enter focus mode'
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={() => void runCommand('sidebar.toggle', context)}
            className={cn('text-text-muted hover:text-text', className)}
          >
            <Icon aria-hidden />
          </Button>
        }
      />
      <TooltipContent>
        {label} {FOCUS_MODE_BINDING !== null && <ShortcutKeys binding={FOCUS_MODE_BINDING} />}
      </TooltipContent>
    </Tooltip>
  )
}
