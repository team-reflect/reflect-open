import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'

interface SwipeActionButtonProps {
  icon: ReactNode
  /**
   * The short visible caption beside the icon (the full name goes in `ariaLabel`).
   */
  label: string
  ariaLabel: string
  /**
   * The pill's background, e.g. `bg-accent` or `bg-destructive`.
   */
  className: string
  onClick: () => void
}

/**
 * One icon-and-caption pill beside a swiped list row. The button fills the row
 * height, so a tap above or below the pill still counts.
 */
export function SwipeActionButton({
  icon,
  label,
  ariaLabel,
  className,
  onClick,
}: SwipeActionButtonProps): ReactElement {
  return (
    <button
      type="button"
      className="swipe-action flex items-center active:opacity-70"
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <span
        className={cn(
          'flex h-9 items-center gap-1 rounded-full px-3 text-sm font-medium text-text-on-brand',
          className,
        )}
      >
        {icon}
        <span aria-hidden>{label}</span>
      </span>
    </button>
  )
}
