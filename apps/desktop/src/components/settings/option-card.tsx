import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SettingsOptionCardProps {
  /** Whether this card's radio input is the chosen value. */
  selected: boolean
  /** Layout for the card's contents (column of icon+label, row of radio+text). */
  className?: string
  /** The radio input plus its visual content. */
  children: ReactNode
}

/**
 * One choice in a settings radio group: a label-as-card with the shared
 * selected/unselected border treatment, a hover wash, and a focus ring lifted
 * to the card whenever the radio inside it has keyboard focus (which also
 * covers `sr-only` inputs). Hosts own the inner layout via `className`.
 */
export function SettingsOptionCard({
  selected,
  className,
  children,
}: SettingsOptionCardProps): ReactElement {
  return (
    <label
      className={cn(
        'flex cursor-pointer rounded-lg border',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus-ring',
        selected ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-hover',
        className,
      )}
    >
      {children}
    </label>
  )
}
