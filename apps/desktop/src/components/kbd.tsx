import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The V1 shortcut chrome: a single rounded pill with a hairline border,
 * surface background, and a subtle shadow. Shared between {@link Kbd}
 * (one literal key) and `ShortcutKeys` (a whole binding in one pill).
 */
export const KBD_FRAME_CLASS =
  'inline-flex items-center justify-center rounded-md border border-border-strong bg-surface px-1 py-0.5 text-[10px] font-semibold uppercase text-text-muted shadow-input dark:border-white/10 dark:bg-white/5'

interface KbdProps {
  children: ReactNode
  className?: string
}

/**
 * One literal key in the original Reflect idiom — a small bordered pill that
 * annotates without shouting. Used for standalone hints (↑↓, esc); whole
 * bindings render through `ShortcutKeys`, which groups keys in one pill.
 */
export function Kbd({ children, className }: KbdProps): ReactElement {
  return (
    <kbd
      className={cn(KBD_FRAME_CLASS, 'min-w-[1lh] text-center font-shortcut leading-4', className)}
    >
      {children}
    </kbd>
  )
}
