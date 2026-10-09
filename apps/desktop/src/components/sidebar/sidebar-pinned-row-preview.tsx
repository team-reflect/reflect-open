import type { ReactElement } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'
import { cn } from '@/lib/utils.ts'

interface SidebarPinnedRowPreviewProps {
  label: string
  active: boolean
  overlay?: boolean
  placeholder?: boolean
  /** A keymap-registry binding to show beside the label, e.g. `Mod-6`. */
  shortcut?: string | null
}

export function SidebarPinnedRowPreview({
  active,
  label,
  overlay = false,
  placeholder = false,
  shortcut = null,
}: SidebarPinnedRowPreviewProps): ReactElement {
  const stateClass = placeholder
    ? 'bg-surface-hover text-transparent'
    : overlay
      ? 'bg-white text-text-secondary'
      : active
        ? 'bg-surface-hover text-text-secondary dark:bg-transparent dark:text-accent'
        : 'text-text-secondary hover:bg-surface-hover hover:text-text'

  return (
    <span
      className={cn(
        'group flex w-full touch-none items-center rounded-md leading-5',
        stateClass,
        overlay && 'shadow-sm',
      )}
    >
      <span className={cn('min-w-0 flex-1 py-1 px-2.5 text-left', placeholder && 'invisible')}>
        <span className="block truncate text-xs font-medium">{label}</span>
      </span>
      {shortcut !== null && !placeholder ? (
        <ShortcutKeys binding={shortcut} className="mr-1.5 text-[10px]" />
      ) : null}
    </span>
  )
}
