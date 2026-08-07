import type { ReactElement, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FilterChipProps {
  /** The chip's label (active chips usually show their value). */
  children: ReactNode
  active?: boolean
  /** Chips that open a picker drawer show a chevron. */
  hasMenu?: boolean
  onClick: () => void
}

/**
 * One badge in the All tab's filter row: a pill that toggles a filter or opens
 * its picker drawer. Defaults keep it a plain inactive toggle.
 */
export function FilterChip({
  children,
  active = false,
  hasMenu = false,
  onClick,
}: FilterChipProps): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-xs font-medium',
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border text-text-muted',
      )}
    >
      {children}
      {hasMenu && <ChevronDown className="-mr-1 size-3.5 opacity-70" />}
    </button>
  )
}
