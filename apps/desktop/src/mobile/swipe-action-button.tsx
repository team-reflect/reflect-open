import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Width (px) of one action button under a swipeable list row. */
export const SWIPE_ACTION_WIDTH = 68

interface SwipeActionButtonProps {
  icon: ReactNode
  /** The short visible caption under the icon (the full name goes in `ariaLabel`). */
  label: string
  ariaLabel: string
  /** Mirror of the row's revealed state: hidden actions leave the tab order. */
  revealed: boolean
  /** The action's background, e.g. `bg-accent` or `bg-destructive`. */
  className: string
  onClick: () => void
}

/** One icon-over-caption action button revealed underneath a swiped list row. */
export function SwipeActionButton({
  icon,
  label,
  ariaLabel,
  revealed,
  className,
  onClick,
}: SwipeActionButtonProps): ReactElement {
  return (
    <button
      type="button"
      tabIndex={revealed ? 0 : -1}
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
