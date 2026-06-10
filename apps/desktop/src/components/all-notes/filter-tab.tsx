import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'

interface FilterTabProps {
  label: string
  active: boolean
  onClick: () => void
}

/** One segment of the All Notes tag-filter group. */
export function FilterTab({ label, active, onClick }: FilterTabProps): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-[13px] font-medium transition-colors duration-100',
        active
          ? 'bg-surface-hover text-text'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text',
      )}
    >
      {label}
    </button>
  )
}
