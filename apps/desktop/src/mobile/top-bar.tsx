import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A mobile screen's top bar. The divider hangs below the rows instead of
 * inside a fixed box, so every screen's line lands on the same pixel.
 */
export function MobileTopBar({ children }: { children: ReactNode }): ReactElement {
  return <header className="shrink-0 border-b border-border">{children}</header>
}

/** A fixed 48px bar row whose content sits on the screen's 16px gutter. */
export function MobileTopBarRow({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}): ReactElement {
  return <div className={cn('flex h-12 items-center gap-1 px-4', className)}>{children}</div>
}

/**
 * A row's 40px icon action. `edge` pulls it 12px past the gutter so the
 * glyph, not the button box, lines up with the row's content.
 */
export function MobileTopBarIconButton({
  edge,
  className,
  ...props
}: ComponentProps<typeof Button> & { edge?: 'leading' | 'trailing' }): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'size-10 shrink-0',
        edge === 'leading' && '-ml-3',
        edge === 'trailing' && '-mr-3',
        className,
      )}
      {...props}
    />
  )
}

/** A bar row that scrolls sideways (filter chips), fading at the edges. */
export function MobileTopBarScrollableRow({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="w-full overflow-hidden">
      <div className="scroll-fade-x scrollbar-none overflow-x-auto px-4">{children}</div>
    </div>
  )
}
