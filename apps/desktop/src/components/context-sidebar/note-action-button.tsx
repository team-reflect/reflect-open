import type { ReactElement, ReactNode } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface NoteActionButtonProps {
  isActive: boolean
  disabled?: boolean
  onClick: () => Promise<void>
  icon: ReactNode
  labels: { active: string; inactive: string }
  keybinding?: string | null
  tooltip?: string | undefined
}

/** Shared presentation for note flag actions. State and persistence belong to the caller. */
export function NoteActionButton({
  isActive,
  disabled = false,
  onClick,
  icon,
  labels,
  keybinding = null,
  tooltip,
}: NoteActionButtonProps): ReactElement {
  const button = (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className="group relative flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start hover:bg-surface-hover disabled:opacity-50"
    >
      <span
        className={cn(
          'flex h-5 w-5 flex-none items-center justify-center',
          isActive ? 'text-accent' : 'text-text-muted group-hover:text-text',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {isActive ? labels.active : labels.inactive}
      </span>
      {keybinding !== null ? (
        <ShortcutKeys binding={keybinding} className="invisible group-hover:visible" />
      ) : null}
    </button>
  )

  if (!tooltip) {
    return button
  }

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
