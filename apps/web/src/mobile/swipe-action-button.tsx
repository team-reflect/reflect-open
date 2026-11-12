import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'

/** Width (px) of one action button under a swipeable list row. */
export const SWIPE_ACTION_WIDTH = 68

interface SwipeActionButtonProps {
  icon: ReactNode
  /** The short visible caption under the icon (the full name goes in `ariaLabel`). */
  label: string
  ariaLabel: string
  /** The action's background, e.g. `bg-accent` or `bg-destructive`. */
  className: string
  onClick: () => void
}

/** One icon-over-caption action button revealed underneath a swiped list row. */
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
      className={cn(
        'flex h-full flex-col items-center justify-center gap-1 text-[10px] font-medium text-text-on-brand active:opacity-70',
        className,
      )}
      style={{ width: SWIPE_ACTION_WIDTH }}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {icon}
      <span aria-hidden>{label}</span>
    </button>
  )
}
