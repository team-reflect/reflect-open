import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'

export function MobileTopBarIconButton({
  edge,
  className,
  ...props
}: ComponentProps<typeof Button> & { edge?: 'leading' | 'trailing' | undefined }): ReactElement {
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
