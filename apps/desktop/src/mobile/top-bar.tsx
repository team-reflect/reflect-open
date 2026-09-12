import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function MobileTopBar({ children }: { children: ReactNode }): ReactElement {
  return <header className="shrink-0 border-b border-border">{children}</header>
}

export function MobileTopBarRow({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}): ReactElement {
  return <div className={cn('flex h-12 items-center gap-1 px-4', className)}>{children}</div>
}

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

export function MobileTopBarScrollableRow({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="w-full overflow-hidden">
      <div className="scroll-fade-x scrollbar-none overflow-x-auto px-4">{children}</div>
    </div>
  )
}
