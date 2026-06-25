import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'

interface SidebarPinnedRowPreviewProps {
  label: string
  active: boolean
  overlay?: boolean
  placeholder?: boolean
}

export function SidebarPinnedRowPreview({
  active,
  label,
  overlay = false,
  placeholder = false,
}: SidebarPinnedRowPreviewProps): ReactElement {
  const stateClass = placeholder
    ? 'bg-surface-hover text-transparent'
    : overlay
      ? 'bg-white text-text-secondary'
    : active
      ? 'bg-surface-hover text-text-secondary dark:bg-transparent'
    : 'text-text-secondary'

  return (
    <span
      className={cn(
        'group flex w-full touch-none items-center rounded-md leading-5 transition-colors duration-[50ms]',
        stateClass,
        overlay && 'shadow-sm',
      )}
    >
      <span className={cn('min-w-0 flex-1 py-1 px-2.5 text-left', placeholder && 'invisible')}>
        <span className="block truncate text-xs font-medium">{label}</span>
      </span>
    </span>
  )
}
