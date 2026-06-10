import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface KbdProps {
  children: ReactNode
  className?: string
}

/**
 * One keycap, in the original Reflect idiom: a small, low-contrast bordered
 * cap that annotates without shouting. Composed by {@link ShortcutKeys} for
 * whole bindings and used directly for literal hints (↑↓, esc).
 */
export function Kbd({ children, className }: KbdProps): ReactElement {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px]',
        'border border-[var(--border)] bg-[var(--surface)] px-1',
        'font-sans text-[10px] font-medium leading-none text-[color:var(--text-muted)]',
        'shadow-[var(--shadow-input)] dark:bg-white/5',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
